import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const filename = fileURLToPath(new URL("../components/mission-workspace.tsx", import.meta.url));

// Exercise the real parent props and form handlers with isolated hooks, as in session-gate.test.mjs.
test("stale partial success permits identified follow-up and retains role/uncertainty gates", () => {
  const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText + '\nexports.outcomeForAcceptance = OutcomeForm; exports.panelsForAcceptance = MissionPanels;';
  let slots, cursor, saved;
  let role = 'seller';
  const hooks = {
    useRef: initial => ({ current: initial }), useEffect() {},
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], value => { slots[index] = value; }];
    },
  };
  const target = new Module(filename); target.filename = filename;
  target.paths = Module._nodeModulePaths(path.dirname(filename));
  const normal = target.require.bind(target);
  target.require = name => name === './coaching-panel' ? {CoachingPanel: () => null} : name === 'react' ? hooks : name === './session-gate' ? {useSession: () => ({actor:{role}})}
    : name === 'next/navigation' ? {useSearchParams: () => new URLSearchParams({step:'Outcome'}),useRouter:()=>({})}
    : name === '@/lib/workflow' ? {steps:['Review','Evidence','Outreach','CRM Note','Approval','Execution','Outcome']}
    : name.startsWith('@/') || name.startsWith('next/') ? {} : normal(name);
  target._compile(compiled, filename);
  const walk = (node, predicate) => {
    if (Array.isArray(node)) return node.flatMap(item => walk(item, predicate));
    if (!node || typeof node !== 'object') return [];
    return [...(predicate(node) ? [node] : []), ...walk(node.props?.children, predicate)];
  };
  const base = { mission: { template: 'account-follow-up-1', status: 'approved', revision: 8, evidence: {evidence_ids: ['evidence']} },
    actions: [{id:'first'}, {id:'second'}], executions: [{action_id:'first', status:'succeeded'}],
    receipts: [{id:'receipt', result:'succeeded'}], outcomes: [] };

  for (const [status, executions, permitted] of [
    ['approved', base.executions, true], ['approved', [], false], ['rejected', base.executions, false],
    ['executing', [...base.executions, {action_id:'second',status:'claimed'}], false],
    ['reconciliation_required', [...base.executions, {action_id:'second',status:'result_unknown'}], false]
  ]) {
    const data = {...base, mission:{...base.mission,status}, executions};
    slots = []; saved = undefined;
    const render = () => {cursor = 0; return target.exports.outcomeForAcceptance({data, disabled:false, save: async body => {saved = body;}});};
    let tree = render();
    const find = predicate => walk(tree, predicate)[0];
    assert.equal(find(node => node.type === 'button').props.disabled, true);
    find(node => node.type === 'input' && node.props.type === 'checkbox').props.onChange({target:{checked:true}});
    tree = render();
    assert.equal(find(node => node.type === 'button').props.disabled, !permitted);
    if (permitted) {
      find(node => node.type === 'input' && node.props.maxLength === 200).props.onChange({target:{value:'manual:remaining-review'}});
      find(node => node.type === 'textarea').props.onChange({target:{value:'Human follow-up; skipped preparation stays unexecuted.'}});
      tree = render();
      const result = find(node => node.type === 'select' && node.props['aria-label'] === 'Reported result');
      assert.equal(result.props.disabled,true); assert.equal(result.props.value,'follow_up_required');
      find(node => node.type === 'form').props.onSubmit({preventDefault(){}});
      assert.equal(saved.manual_action_reference,'manual:remaining-review');
      assert.equal(saved.kind,'follow_up_required'); assert.equal(saved.basis,'manual_report');
      assert.equal(saved.receipt_id,null); assert.equal(saved.expected_revision,8);
    }

  }

  const parentData = {...base, plan:{selected_alternative_id:'choice',alternatives:[{id:'choice',steps:[]}]},
    account:{account:{revision:1,name:'Synthetic'},assessment:{snapshot_hash:'current'}},audit:[],
    mission:{...base.mission,evidence:{...base.mission.evidence,account_revision:1,snapshot_hash:'yesterday'}}};
  for (const [actorRole, status, expected] of [['seller','approved',false],['viewer','approved',true],['seller','superseded',true]]) {
    role=actorRole; slots=[];cursor=0;
    const tree=target.exports.panelsForAcceptance({data:{...parentData,mission:{...parentData.mission,status}},configured:false,refresh(){}});
    const form=walk(tree,node=>node.type===target.exports.outcomeForAcceptance)[0];
    assert.equal(form.props.disabled,expected);
  }

  for (const actorRole of ['seller', 'reviewer', 'admin', 'viewer']) {
    role=actorRole; slots=[];cursor=0;
    const tree=target.exports.panelsForAcceptance({data:{...parentData,
      actions:[{id:'live-action',mode:'live',provider_request:'{"properties":{"hs_task_body":"Exact"}}'}]},configured:false,refresh(){}});
    assert.equal(walk(tree,node=>node.props?.['aria-label']==='Live mission read-only').length,1);
    assert.equal(walk(tree,node=>['button','form',target.exports.outcomeForAcceptance].includes(node.type)).length,0);
    assert.equal(walk(tree,node=>typeof node.type==='function').length,1); // ExactPreview only; no editor/review/outcome.
  }
});
