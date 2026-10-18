export interface paths {
    "/api/auth/session": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Session */
        get: operations["session_api_auth_session_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/auth/login": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Login */
        post: operations["login_api_auth_login_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/auth/logout": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Logout */
        post: operations["logout_api_auth_logout_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/health": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Health */
        get: operations["health_health_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/portfolio": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Portfolio */
        get: operations["portfolio_api_portfolio_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/accounts/{account_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Account */
        get: operations["account_api_accounts__account_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/providers/nebius": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Provider Status */
        get: operations["provider_status_api_providers_nebius_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/providers/nebius/discover": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Discover */
        post: operations["discover_api_providers_nebius_discover_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/accounts/{account_id}/analyze": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Analyze */
        post: operations["analyze_api_accounts__account_id__analyze_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/pipeline": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Run Pipeline */
        post: operations["run_pipeline_api_pipeline_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/pipeline/{run_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Pipeline */
        get: operations["get_pipeline_api_pipeline__run_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/integrations/hubspot/accounts/{account_id}/execution-readiness": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Hubspot Readiness */
        get: operations["hubspot_readiness_api_integrations_hubspot_accounts__account_id__execution_readiness_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/plans": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Create Plan */
        post: operations["create_plan_api_plans_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/plans/generate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Generate Plan */
        post: operations["generate_plan_api_plans_generate_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/plans/runs/{run_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Planning Run */
        get: operations["get_planning_run_api_plans_runs__run_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/plans/{plan_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Plan */
        get: operations["get_plan_api_plans__plan_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/missions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List Missions */
        get: operations["list_missions_api_missions_get"];
        put?: never;
        /** Create Mission */
        post: operations["create_mission_api_missions_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/missions/{mission_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Mission */
        get: operations["get_mission_api_missions__mission_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/missions/{mission_id}/audit": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Audit */
        get: operations["get_audit_api_missions__mission_id__audit_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/missions/{mission_id}/actions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List Actions */
        get: operations["list_actions_api_missions__mission_id__actions_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/missions/{mission_id}/prepare": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Prepare */
        post: operations["prepare_api_missions__mission_id__prepare_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/missions/{mission_id}/supersede": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Supersede Mission */
        post: operations["supersede_mission_api_missions__mission_id__supersede_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/actions/{action_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Action */
        get: operations["get_action_api_actions__action_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/actions/{action_id}/submit": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Submit */
        post: operations["submit_api_actions__action_id__submit_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/actions/{action_id}/history": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Action History */
        get: operations["action_history_api_actions__action_id__history_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/actions/{action_id}/renew-review": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Renew Review */
        post: operations["renew_review_api_actions__action_id__renew_review_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/actions/{action_id}/review": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Review */
        post: operations["review_api_actions__action_id__review_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/actions/{action_id}/decisions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List Decisions */
        get: operations["list_decisions_api_actions__action_id__decisions_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/actions/{action_id}/executions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List Executions */
        get: operations["list_executions_api_actions__action_id__executions_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/actions/{action_id}/execute": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Execute */
        post: operations["execute_api_actions__action_id__execute_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/executions/{execution_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Execution */
        get: operations["get_execution_api_executions__execution_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/receipts/{receipt_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Receipt */
        get: operations["get_receipt_api_receipts__receipt_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/executions/{execution_id}/reconcile": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Reconcile */
        post: operations["reconcile_api_executions__execution_id__reconcile_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/missions/{mission_id}/outcomes": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List Outcomes */
        get: operations["list_outcomes_api_missions__mission_id__outcomes_get"];
        put?: never;
        /** Outcome */
        post: operations["outcome_api_missions__mission_id__outcomes_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/executions/{execution_id}/retry": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Retry */
        post: operations["retry_api_executions__execution_id__retry_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/integrations/hubspot": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Status */
        get: operations["status_api_integrations_hubspot_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/integrations/hubspot/accounts/{account_id}/sync": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Sync */
        post: operations["sync_api_integrations_hubspot_accounts__account_id__sync_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/integrations/hubspot/runs/{run_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Run */
        get: operations["get_run_api_integrations_hubspot_runs__run_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/integrations/hubspot/observations/{observation_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Observation */
        get: operations["get_observation_api_integrations_hubspot_observations__observation_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/integrations/hubspot/accounts/{account_id}/preview": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Preview */
        get: operations["preview_api_integrations_hubspot_accounts__account_id__preview_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/integrations/hubspot/accounts/{account_id}/promote": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Promote */
        post: operations["promote_api_integrations_hubspot_accounts__account_id__promote_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/integrations/hubspot/accounts/{account_id}/restore-sample": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Restore Sample */
        post: operations["restore_sample_api_integrations_hubspot_accounts__account_id__restore_sample_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/integrations/hubspot/sources/{source_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Source Version */
        get: operations["source_version_api_integrations_hubspot_sources__source_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        /** Account */
        Account: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /** Id */
            id: string;
            /** Organization Id */
            organization_id: string;
            /** External Id */
            external_id: string;
            /** Name */
            name: string;
            /** Industry */
            industry: string;
            /** Annual Value */
            annual_value: number | null;
            /** Renewal Date */
            renewal_date: string | null;
            /** Revision */
            revision: number;
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
            /** Synthetic */
            synthetic: boolean;
        };
        /** AccountSource */
        AccountSource: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /** Id */
            id: string;
            /**
             * Kind
             * @enum {string}
             */
            kind: "hubspot" | "local_sample";
            /** Account Revision */
            account_revision: number;
            /** Actor Id */
            actor_id: string;
            /**
             * Selected At
             * Format: date-time
             */
            selected_at: string;
            /** Observation Id */
            observation_id?: string | null;
            /** Provider Updated At */
            provider_updated_at?: string | null;
            /** Mapping Hash */
            mapping_hash?: string | null;
            /** Field Status */
            field_status?: {
                [key: string]: "valid" | "unconfigured" | "missing" | "invalid";
            };
        };
        /** AccountSourceVersion */
        AccountSourceVersion: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /**
             * Account Id
             * Format: uuid
             */
            account_id: string;
            selection: components["schemas"]["AccountSource"];
            account: components["schemas"]["Account"];
            /** Evidence */
            evidence: components["schemas"]["Evidence"][];
            previous_account: components["schemas"]["Account"];
            /** Previous Evidence */
            previous_evidence: components["schemas"]["Evidence"][];
        };
        /** AccountView */
        AccountView: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            account: components["schemas"]["Account"];
            assessment: components["schemas"]["Assessment"];
            /** Evidence */
            evidence: components["schemas"]["Evidence"][];
            /** Renewal Days */
            renewal_days: number | null;
            latest_run?: components["schemas"]["ModelRun"] | null;
            source?: components["schemas"]["AccountSource"] | null;
        };
        /** ActionPreview */
        ActionPreview: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Organization Id */
            organization_id: string;
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
            /** Revision */
            revision: number;
            /**
             * Correlation Id
             * Format: uuid
             */
            correlation_id: string;
            /**
             * Mission Id
             * Format: uuid
             */
            mission_id: string;
            /** Mission Revision */
            mission_revision: number;
            /**
             * Plan Id
             * Format: uuid
             */
            plan_id: string;
            /** Plan Revision */
            plan_revision: number;
            evidence: components["schemas"]["EvidenceBinding"];
            /**
             * Slot Id
             * Format: uuid
             */
            slot_id: string;
            /** Step Id */
            step_id?: string | null;
            destination: components["schemas"]["DestinationBinding"];
            /** Payload */
            payload: components["schemas"]["TaskPayload"] | components["schemas"]["NotePayload"] | components["schemas"]["OutlookPayload"];
            /** Payload Hash */
            payload_hash: string;
            /** Binding Hash */
            binding_hash: string;
            /** Policy Version */
            policy_version: string;
            /**
             * Mode
             * @enum {string}
             */
            mode: "simulation" | "live";
            /** Preparer Id */
            preparer_id: string;
            /** Provider Request */
            provider_request?: string | null;
            /**
             * Status
             * @enum {string}
             */
            status: "draft" | "submitted" | "superseded";
        };
        /** ActionProposal */
        ActionProposal: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /**
             * Kind
             * @enum {string}
             */
            kind: "manual_review" | "support_escalation" | "renewal_prep" | "optimization_review" | "reactivation" | "follow_up" | "monitor";
            /** Rationale */
            rationale: string;
            /** Evidence Ids */
            evidence_ids: string[];
            /**
             * Approval Status
             * @default unapproved
             * @constant
             */
            approval_status: "unapproved";
            /**
             * External Execution
             * @default false
             * @constant
             */
            external_execution: false;
        };
        /** Actor */
        Actor: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /** Id */
            id: string;
            /** Username */
            username: string;
            /** Organization Id */
            organization_id: string;
            /**
             * Role
             * @enum {string}
             */
            role: "admin" | "reviewer" | "seller" | "viewer";
        };
        /** Alternative */
        Alternative: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Rationale */
            rationale: string;
            /** Evidence Ids */
            evidence_ids: string[];
            /** Steps */
            steps: components["schemas"]["PlanStep"][];
            /** Risks */
            risks: string[];
        };
        /** Analysis */
        Analysis: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /** Findings */
            findings: components["schemas"]["Finding"][];
            /** Next Steps */
            next_steps: components["schemas"]["Finding"][];
            /** Caveats */
            caveats: string[];
        };
        /** AnalyzeRequest */
        AnalyzeRequest: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /** Expected Revision */
            expected_revision: number;
            /** Expected Snapshot Hash */
            expected_snapshot_hash: string;
        };
        /** Assessment */
        Assessment: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /**
             * Policy Version
             * @default baseline-1
             * @constant
             */
            policy_version: "baseline-1";
            /** Snapshot Hash */
            snapshot_hash: string;
            /**
             * As Of
             * Format: date
             */
            as_of: string;
            /** Health */
            health: number;
            /** Risk */
            risk: number;
            /** Opportunity */
            opportunity: number;
            /** Confidence */
            confidence: number;
            /**
             * Requires Review
             * @default false
             */
            requires_review: boolean;
            /** Needs Attention */
            needs_attention: boolean;
            /** Growth Signal */
            growth_signal: boolean;
            /** Recommendation */
            recommendation: string;
            /** Factors */
            factors: components["schemas"]["ScoreFactor"][];
            /** Caveats */
            caveats: string[];
        };
        /** AuditEvent */
        AuditEvent: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Organization Id */
            organization_id: string;
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
            /** Revision */
            revision: number;
            /**
             * Correlation Id
             * Format: uuid
             */
            correlation_id: string;
            /** Sequence */
            sequence: number;
            /**
             * Entity Id
             * Format: uuid
             */
            entity_id: string;
            /** Entity Revision */
            entity_revision: number;
            /** Actor Id */
            actor_id: string;
            /** Event Kind */
            event_kind: string;
            /** Previous State */
            previous_state?: string | null;
            /** New State */
            new_state: string;
            /** Action Id */
            action_id?: string | null;
            /** Decision Id */
            decision_id?: string | null;
            /** Execution Id */
            execution_id?: string | null;
            /** Binding Hash */
            binding_hash?: string | null;
        };
        /** CommunicationDrafts */
        CommunicationDrafts: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /**
             * Action Kind
             * @enum {string}
             */
            action_kind: "manual_review" | "support_escalation" | "renewal_prep" | "optimization_review" | "reactivation" | "follow_up" | "monitor";
            email: components["schemas"]["Finding"] | null;
            call_script: components["schemas"]["Finding"] | null;
            voice_summary: components["schemas"]["Finding"] | null;
            internal_note: components["schemas"]["Finding"];
            /** Caveats */
            caveats: string[];
        };
        /** CommunicationResult */
        CommunicationResult: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /**
             * Status
             * @enum {string}
             */
            status: "deterministic_template" | "model_validated" | "blocked" | "unconfigured" | "failed" | "invalid_output";
            /** Internal Note */
            internal_note?: string | null;
            /** Evidence Ids */
            evidence_ids: string[];
            model_run?: components["schemas"]["ModelRun"] | null;
            drafts?: components["schemas"]["CommunicationDrafts"] | null;
        };
        /** DestinationBinding */
        DestinationBinding: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /** Connector Id */
            connector_id: string;
            /**
             * Provider
             * @enum {string}
             */
            provider: "hubspot" | "microsoft";
            /** Configuration Revision */
            configuration_revision: number;
            /** Tenant Id */
            tenant_id: string;
            /**
             * Target Account Id
             * Format: uuid
             */
            target_account_id: string;
            /** Target Resource Id */
            target_resource_id: string;
            /** Delegated User Id */
            delegated_user_id?: string | null;
            /** Mailbox Id */
            mailbox_id?: string | null;
        };
        /** Evidence */
        Evidence: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /** Id */
            id: string;
            /** Account Id */
            account_id: string;
            /** Organization Id */
            organization_id: string;
            /**
             * Metric
             * @enum {string}
             */
            metric: "usage_change" | "support_cases" | "expansion" | "renewal";
            /** Value */
            value: number;
            /** Fact */
            fact: string;
            /** Source */
            source: string;
            /** Source Record */
            source_record: string;
            /**
             * Observed At
             * Format: date-time
             */
            observed_at: string;
            /**
             * Ingested At
             * Format: date-time
             */
            ingested_at: string;
            /**
             * Polarity
             * @enum {string}
             */
            polarity: "positive" | "negative" | "neutral";
            /** Synthetic */
            synthetic: boolean;
        };
        /** EvidenceBinding */
        EvidenceBinding: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /**
             * Account Id
             * Format: uuid
             */
            account_id: string;
            /** Account Revision */
            account_revision: number;
            /** Snapshot Hash */
            snapshot_hash: string;
            /** Assessment Policy Version */
            assessment_policy_version: string;
            /**
             * As Of
             * Format: date
             */
            as_of: string;
            /** Evidence Ids */
            evidence_ids: string[];
        };
        /** ExecuteRequest */
        ExecuteRequest: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /** Expected Revision */
            expected_revision: number;
            /**
             * Decision Id
             * Format: uuid
             */
            decision_id: string;
            /** Idempotency Key */
            idempotency_key: string;
        };
        /** Execution */
        Execution: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Organization Id */
            organization_id: string;
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
            /** Revision */
            revision: number;
            /**
             * Correlation Id
             * Format: uuid
             */
            correlation_id: string;
            /**
             * Action Id
             * Format: uuid
             */
            action_id: string;
            /** Action Revision */
            action_revision: number;
            /**
             * Decision Id
             * Format: uuid
             */
            decision_id: string;
            /** Binding Hash */
            binding_hash: string;
            /** Logical Action Key */
            logical_action_key: string;
            /** Idempotency Key */
            idempotency_key: string;
            /** Requesting Actor Id */
            requesting_actor_id: string;
            /** Attempt */
            attempt: number;
            /**
             * Status
             * @enum {string}
             */
            status: "claimed" | "dispatching" | "succeeded" | "failed" | "result_unknown";
            /**
             * Claimed At
             * Format: date-time
             */
            claimed_at: string;
            /** Dispatched At */
            dispatched_at?: string | null;
            /** Finished At */
            finished_at?: string | null;
            /** Receipt Id */
            receipt_id?: string | null;
        };
        /** Finding */
        Finding: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /** Text */
            text: string;
            /** Evidence Ids */
            evidence_ids: string[];
        };
        /** GovernanceResult */
        GovernanceResult: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /**
             * Status
             * @enum {string}
             */
            status: "review_required" | "ready_for_preparation";
            /** Confidence */
            confidence: number;
            /** Caveats */
            caveats: string[];
            /**
             * Requires Human Approval
             * @default true
             * @constant
             */
            requires_human_approval: true;
        };
        /** HTTPValidationError */
        HTTPValidationError: {
            /** Detail */
            detail?: components["schemas"]["ValidationError"][];
        };
        /** HealthResult */
        HealthResult: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /** Health */
            health: number;
            /** Risk */
            risk: number;
            /** Factors */
            factors: components["schemas"]["ScoreFactor"][];
        };
        /** HubSpotExecutionReadiness */
        HubSpotExecutionReadiness: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /** Account Id */
            account_id: string;
            /** Organization Id */
            organization_id: string;
            /** Account Revision */
            account_revision: number;
            /** Write Configured */
            write_configured: boolean;
            /** Readback Configured */
            readback_configured: boolean;
            /** Can Prepare */
            can_prepare: boolean;
            /** Can Reconcile */
            can_reconcile: boolean;
            destination: components["schemas"]["DestinationBinding"] | null;
        };
        /** HubSpotObservation */
        HubSpotObservation: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Organization Id */
            organization_id: string;
            /**
             * Account Id
             * Format: uuid
             */
            account_id: string;
            /** Account Revision */
            account_revision: number;
            /** Portal Id */
            portal_id: string;
            /** Company Id */
            company_id: string;
            /**
             * Source
             * @default hubspot
             * @constant
             */
            source: "hubspot";
            /** Source Record */
            source_record: string;
            /**
             * Provider Created At
             * Format: date-time
             */
            provider_created_at: string;
            /**
             * Provider Updated At
             * Format: date-time
             */
            provider_updated_at: string;
            /**
             * Fetched At
             * Format: date-time
             */
            fetched_at: string;
            /** Fingerprint */
            fingerprint: string;
            /** Sequence */
            sequence: number;
            /** Properties */
            properties: {
                [key: string]: string | null;
            };
            /** Property Types */
            property_types?: {
                [key: string]: string;
            };
            /** Mapping Hash */
            mapping_hash?: string | null;
            /** Property Mapping */
            property_mapping?: {
                [key: string]: components["schemas"]["HubSpotProperty"];
            };
        };
        /** HubSpotPreview */
        HubSpotPreview: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /**
             * Observation Id
             * Format: uuid
             */
            observation_id: string;
            /** Expected Account Revision */
            expected_account_revision: number;
            /** Mapping Hash */
            mapping_hash: string;
            /** Preview Hash */
            preview_hash: string;
            account: components["schemas"]["Account"];
            /** Evidence */
            evidence: components["schemas"]["Evidence"][];
            /** Field Status */
            field_status: {
                [key: string]: string;
            };
        };
        /** HubSpotPromoteRequest */
        HubSpotPromoteRequest: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /** Expected Account Revision */
            expected_account_revision: number;
            /**
             * Observation Id
             * Format: uuid
             */
            observation_id: string;
            /** Preview Hash */
            preview_hash: string;
        };
        /** HubSpotProperty */
        HubSpotProperty: {
            /** Property */
            property: string;
            /**
             * Type
             * @enum {string}
             */
            type: "number" | "date";
            /** Unit */
            unit: string;
            /** Meaning */
            meaning: string;
            /** Observed At Property */
            observed_at_property?: string | null;
        };
        /** HubSpotStatus */
        HubSpotStatus: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /** Configured */
            configured: boolean;
            /**
             * Status
             * @enum {string}
             */
            status: "unconfigured" | "configured_unverified";
        };
        /** HubSpotSyncRequest */
        HubSpotSyncRequest: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /** Expected Account Revision */
            expected_account_revision: number;
        };
        /** HubSpotSyncRun */
        HubSpotSyncRun: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Organization Id */
            organization_id: string;
            /**
             * Account Id
             * Format: uuid
             */
            account_id: string;
            /** Actor Id */
            actor_id: string;
            /** Account Revision */
            account_revision?: number | null;
            /** Portal Id */
            portal_id: string;
            /** Company Id */
            company_id: string;
            /**
             * Started At
             * Format: date-time
             */
            started_at: string;
            /**
             * Finished At
             * Format: date-time
             */
            finished_at: string;
            /**
             * Status
             * @enum {string}
             */
            status: "succeeded" | "failed";
            /** Disposition */
            disposition?: ("baseline" | "unchanged" | "changed") | null;
            /** Observation Id */
            observation_id?: string | null;
            /** Error Code */
            error_code?: string | null;
        };
        /** LoginRequest */
        LoginRequest: {
            /** Username */
            username: string;
            /**
             * Password
             * Format: password
             */
            password: string;
        };
        /** Mission */
        Mission: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Organization Id */
            organization_id: string;
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
            /** Revision */
            revision: number;
            /**
             * Correlation Id
             * Format: uuid
             */
            correlation_id: string;
            /**
             * Account Id
             * Format: uuid
             */
            account_id: string;
            /** Owner Id */
            owner_id: string;
            /**
             * Template
             * @enum {string}
             */
            template: "account-action-1" | "account-note-1" | "account-outlook-draft-1" | "account-follow-up-1";
            /**
             * Plan Id
             * Format: uuid
             */
            plan_id: string;
            /** Plan Revision */
            plan_revision: number;
            /** Alternative Id */
            alternative_id?: string | null;
            /**
             * Content Revision
             * @default 1
             */
            content_revision: number;
            evidence: components["schemas"]["EvidenceBinding"];
            /**
             * Status
             * @enum {string}
             */
            status: "draft" | "prepared" | "awaiting_review" | "approved" | "rejected" | "revision_required" | "executing" | "executed" | "execution_failed" | "reconciliation_required" | "outcome_recorded" | "completed" | "superseded";
            /**
             * Current Step
             * @enum {string}
             */
            current_step: "Review" | "Evidence" | "Outreach" | "CRM Note" | "Approval" | "Execution" | "Outcome";
            /** Allowed Kinds */
            allowed_kinds: ("hubspot_task_create" | "hubspot_note_create" | "outlook_draft_create")[];
            /**
             * Transition Ids
             * @default []
             */
            transition_ids: string[];
            /** Supersedes Id */
            supersedes_id?: string | null;
            /** Superseded By Id */
            superseded_by_id?: string | null;
        };
        /** MissionRequest */
        MissionRequest: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /** Expected Revision */
            expected_revision: number;
            /**
             * Plan Id
             * Format: uuid
             */
            plan_id: string;
            /**
             * Template
             * @default account-action-1
             * @enum {string}
             */
            template: "account-action-1" | "account-note-1" | "account-outlook-draft-1" | "account-follow-up-1";
            /** Alternative Id */
            alternative_id?: string | null;
        };
        /** ModelRun */
        ModelRun: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /** Id */
            id: string;
            /** Account Id */
            account_id: string;
            /** Organization Id */
            organization_id: string;
            /** Account Revision */
            account_revision: number;
            /** Snapshot Hash */
            snapshot_hash: string;
            /**
             * Provider
             * @default nebius
             */
            provider: string;
            /**
             * Task
             * @default analysis
             * @enum {string}
             */
            task: "analysis" | "drafts" | "planning";
            /** Model */
            model: string | null;
            /**
             * Status
             * @enum {string}
             */
            status: "unconfigured" | "failed" | "invalid_output" | "succeeded";
            /**
             * Validation
             * @enum {string}
             */
            validation: "not_run" | "rejected" | "schema_and_references_valid";
            /**
             * Started At
             * Format: date-time
             */
            started_at: string;
            /** Latency Ms */
            latency_ms: number;
            /** Request Id */
            request_id?: string | null;
            /** Input Tokens */
            input_tokens?: number | null;
            /** Output Tokens */
            output_tokens?: number | null;
            /** Error Code */
            error_code?: string | null;
            analysis?: components["schemas"]["Analysis"] | null;
            drafts?: components["schemas"]["CommunicationDrafts"] | null;
            planning?: components["schemas"]["PlanningOutput"] | null;
        };
        /** NotePayload */
        NotePayload: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "hubspot_note_create";
            /** Body */
            body: string;
        };
        /** OpportunityResult */
        OpportunityResult: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /** Score */
            score: number;
            /** Factors */
            factors: components["schemas"]["ScoreFactor"][];
        };
        /** Outcome */
        Outcome: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Organization Id */
            organization_id: string;
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
            /** Revision */
            revision: number;
            /**
             * Correlation Id
             * Format: uuid
             */
            correlation_id: string;
            /**
             * Mission Id
             * Format: uuid
             */
            mission_id: string;
            /** Observer Id */
            observer_id: string;
            /**
             * Observed At
             * Format: date-time
             */
            observed_at: string;
            report: components["schemas"]["OutcomeRequest"];
            /** Supersedes Id */
            supersedes_id?: string | null;
        };
        /** OutcomeRequest */
        OutcomeRequest: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /** Expected Revision */
            expected_revision: number;
            /** Supersedes Id */
            supersedes_id?: string | null;
            /** Receipt Id */
            receipt_id?: string | null;
            /** Manual Action Reference */
            manual_action_reference?: string | null;
            /**
             * Kind
             * @enum {string}
             */
            kind: "meeting_booked" | "customer_contacted" | "renewal_risk_reduced" | "opportunity_created" | "no_response" | "follow_up_required";
            /**
             * Basis
             * @enum {string}
             */
            basis: "manual_report" | "provider_observation";
            /** Evidence Ids */
            evidence_ids: string[];
            /** Note */
            note: string;
        };
        /** OutlookPayload */
        OutlookPayload: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "outlook_draft_create";
            /** To */
            to: string[];
            /** Subject */
            subject: string;
            /** Body Text */
            body_text: string;
        };
        /** PipelineRequest */
        PipelineRequest: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /**
             * Intent
             * @default attention
             * @enum {string}
             */
            intent: "attention" | "risk" | "growth" | "renewal" | "manual_review" | "monitor";
            /**
             * Limit
             * @default 3
             */
            limit: number;
            /**
             * Communicate
             * @default false
             */
            communicate: boolean;
            /**
             * Communication Mode
             * @default internal_note
             * @enum {string}
             */
            communication_mode: "internal_note" | "drafts";
        };
        /** PipelineRun */
        PipelineRun: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /** Id */
            id: string;
            /** Organization Id */
            organization_id: string;
            /** Actor Id */
            actor_id: string | null;
            /**
             * Started At
             * Format: date-time
             */
            started_at: string;
            /**
             * As Of
             * Format: date
             */
            as_of: string;
            request: components["schemas"]["PipelineRequest"];
            /**
             * Status
             * @enum {string}
             */
            status: "deterministic" | "model_validated" | "partial";
            /** Contexts */
            contexts: components["schemas"]["SignalContext"][];
            /** Recommendations */
            recommendations: components["schemas"]["Recommendation"][];
            /** Steps */
            steps: components["schemas"]["PipelineStep"][];
            /** Caveats */
            caveats: string[];
        };
        /** PipelineStep */
        PipelineStep: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /**
             * Role
             * @enum {string}
             */
            role: "ingestion" | "health" | "opportunity" | "governance" | "action" | "communication";
            /** Processed */
            processed: number;
            /**
             * Status
             * @default completed
             * @enum {string}
             */
            status: "completed" | "partial";
        };
        /** Plan */
        Plan: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Organization Id */
            organization_id: string;
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
            /** Revision */
            revision: number;
            /**
             * Correlation Id
             * Format: uuid
             */
            correlation_id: string;
            /**
             * Account Id
             * Format: uuid
             */
            account_id: string;
            /** Pipeline Run Id */
            pipeline_run_id?: string | null;
            evidence: components["schemas"]["EvidenceBinding"];
            /** Author Id */
            author_id: string;
            /**
             * Source
             * @enum {string}
             */
            source: "deterministic" | "model";
            /** Model Run Id */
            model_run_id?: string | null;
            /**
             * Status
             * @enum {string}
             */
            status: "draft" | "valid" | "blocked" | "superseded";
            /** Alternatives */
            alternatives: components["schemas"]["Alternative"][];
            /**
             * Selected Alternative Id
             * Format: uuid
             */
            selected_alternative_id: string;
            /** Caveats */
            caveats: string[];
            /**
             * Validation
             * @enum {string}
             */
            validation: "not_run" | "valid" | "blocked";
        };
        /** PlanRequest */
        PlanRequest: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /** Expected Revision */
            expected_revision: number;
            /**
             * Account Id
             * Format: uuid
             */
            account_id: string;
            /** Expected Snapshot Hash */
            expected_snapshot_hash: string;
            /**
             * Intent
             * @enum {string}
             */
            intent: "attention" | "risk" | "growth" | "renewal" | "manual_review" | "monitor";
            /** Model Run Id */
            model_run_id?: string | null;
            /**
             * Action Kind
             * @default hubspot_task_create
             * @enum {string}
             */
            action_kind: "hubspot_task_create" | "hubspot_note_create" | "outlook_draft_create";
            /** Strategy */
            strategy?: ("single_action" | "follow_up") | null;
        };
        /** PlanStep */
        PlanStep: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /**
             * Kind
             * @enum {string}
             */
            kind: "hubspot_task_create" | "hubspot_note_create" | "outlook_draft_create";
            /** Content */
            content: string;
            /** Evidence Ids */
            evidence_ids: string[];
            /**
             * Dependencies
             * @default []
             */
            dependencies: string[];
        };
        /** PlanningOutput */
        PlanningOutput: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /**
             * Intent
             * @enum {string}
             */
            intent: "attention" | "risk" | "growth" | "renewal" | "manual_review" | "monitor";
            /**
             * Action Kind
             * @enum {string}
             */
            action_kind: "hubspot_task_create" | "hubspot_note_create" | "outlook_draft_create";
            /**
             * Strategy
             * @enum {string}
             */
            strategy: "single_action" | "follow_up";
            /** Alternatives */
            alternatives: components["schemas"]["Alternative"][];
            /**
             * Selected Alternative Id
             * Format: uuid
             */
            selected_alternative_id: string;
            /** Caveats */
            caveats: string[];
        };
        /** Portfolio */
        Portfolio: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /** Organization Id */
            organization_id: string;
            /**
             * Mode
             * @default local_sample
             * @enum {string}
             */
            mode: "local_sample" | "hubspot" | "mixed";
            /**
             * As Of
             * Format: date
             */
            as_of: string;
            /** Annual Value */
            annual_value: number | null;
            /**
             * Annual Value Missing Count
             * @default 0
             */
            annual_value_missing_count: number;
            /** Attention Count */
            attention_count: number;
            /** Growth Count */
            growth_count: number;
            /** Accounts */
            accounts: components["schemas"]["AccountView"][];
        };
        /** PrepareRequest */
        PrepareRequest: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /** Expected Revision */
            expected_revision: number;
            /**
             * Mode
             * @default simulation
             * @enum {string}
             */
            mode: "simulation" | "live";
            /**
             * Alternative Id
             * Format: uuid
             */
            alternative_id: string;
            /** Step Id */
            step_id?: string | null;
            /** Connector Id */
            connector_id: string;
            /** Payload */
            payload: components["schemas"]["TaskPayload"] | components["schemas"]["NotePayload"] | components["schemas"]["OutlookPayload"];
        };
        /** ProviderStatus */
        ProviderStatus: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /**
             * Provider
             * @default nebius
             */
            provider: string;
            /** Configured */
            configured: boolean;
            /** Model */
            model: string | null;
            /**
             * Status
             * @enum {string}
             */
            status: "unconfigured" | "configured_unverified" | "discovered" | "failed";
            /** Models */
            models?: string[];
            /** Error Code */
            error_code?: string | null;
        };
        /** Receipt */
        Receipt: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Organization Id */
            organization_id: string;
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
            /** Revision */
            revision: number;
            /**
             * Correlation Id
             * Format: uuid
             */
            correlation_id: string;
            /**
             * Execution Id
             * Format: uuid
             */
            execution_id: string;
            /**
             * Action Id
             * Format: uuid
             */
            action_id: string;
            /**
             * Decision Id
             * Format: uuid
             */
            decision_id: string;
            /** Binding Hash */
            binding_hash: string;
            destination: components["schemas"]["DestinationBinding"];
            /**
             * Result
             * @enum {string}
             */
            result: "succeeded" | "failed" | "result_unknown";
            /**
             * Mode
             * @enum {string}
             */
            mode: "simulation" | "live";
            /** Provider Request Id */
            provider_request_id?: string | null;
            /** Provider Resource Id */
            provider_resource_id?: string | null;
            /**
             * Recorded At
             * Format: date-time
             */
            recorded_at: string;
            /**
             * Verification
             * @enum {string}
             */
            verification: "not_run" | "verified" | "mismatch" | "unavailable";
            /** Readback Hash */
            readback_hash?: string | null;
            /** Readback At */
            readback_at?: string | null;
            /** Error Code */
            error_code?: string | null;
        };
        /** Recommendation */
        Recommendation: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /** Account Id */
            account_id: string;
            /** Rank */
            rank: number;
            assessment: components["schemas"]["Assessment"];
            health: components["schemas"]["HealthResult"];
            opportunity: components["schemas"]["OpportunityResult"];
            governance: components["schemas"]["GovernanceResult"];
            action: components["schemas"]["ActionProposal"];
            communication: components["schemas"]["CommunicationResult"];
        };
        /** ReviewDecision */
        ReviewDecision: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Organization Id */
            organization_id: string;
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
            /** Revision */
            revision: number;
            /**
             * Correlation Id
             * Format: uuid
             */
            correlation_id: string;
            /**
             * Action Id
             * Format: uuid
             */
            action_id: string;
            /** Action Revision */
            action_revision: number;
            /** Binding Hash */
            binding_hash: string;
            /**
             * Decision
             * @enum {string}
             */
            decision: "approved" | "rejected" | "revision_required";
            /** Reviewer Id */
            reviewer_id: string;
            /** Authority Version */
            authority_version: string;
            /**
             * Decided At
             * Format: date-time
             */
            decided_at: string;
            /**
             * Expires At
             * Format: date-time
             */
            expires_at: string;
            /** Reason */
            reason?: string | null;
        };
        /** ReviewRequest */
        ReviewRequest: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /** Expected Revision */
            expected_revision: number;
            /** Binding Hash */
            binding_hash: string;
            /**
             * Decision
             * @enum {string}
             */
            decision: "approved" | "rejected" | "revision_required";
            /** Reason */
            reason?: string | null;
        };
        /** RevisionRequest */
        RevisionRequest: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /** Expected Revision */
            expected_revision: number;
        };
        /** ScoreFactor */
        ScoreFactor: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /** Metric */
            metric: string;
            /** Value */
            value: number | null;
            /** Evidence Id */
            evidence_id: string | null;
            /** Risk Contribution */
            risk_contribution: number;
            /** Opportunity Contribution */
            opportunity_contribution: number;
        };
        /** SessionView */
        SessionView: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /**
             * Mode
             * @enum {string}
             */
            mode: "sample" | "session";
            actor?: components["schemas"]["Actor"] | null;
        };
        /** SignalContext */
        SignalContext: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            account: components["schemas"]["Account"];
            /** Evidence */
            evidence: components["schemas"]["Evidence"][];
            /** Positive Count */
            positive_count: number;
            /** Negative Count */
            negative_count: number;
        };
        /** SubmitRequest */
        SubmitRequest: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /** Expected Revision */
            expected_revision: number;
            /** Binding Hash */
            binding_hash: string;
        };
        /** SupersedeRequest */
        SupersedeRequest: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /** Expected Revision */
            expected_revision: number;
            /**
             * Plan Id
             * Format: uuid
             */
            plan_id: string;
            /** Expected Plan Revision */
            expected_plan_revision: number;
            /** Alternative Id */
            alternative_id?: string | null;
        };
        /** TaskPayload */
        TaskPayload: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "hubspot_task_create";
            /** Title */
            title: string;
            /** Body */
            body: string;
            /** Due At */
            due_at?: string | null;
        };
        /** ValidationError */
        ValidationError: {
            /** Location */
            loc: (string | number)[];
            /** Message */
            msg: string;
            /** Error Type */
            type: string;
            /** Input */
            input?: unknown;
            /** Context */
            ctx?: Record<string, never>;
        };
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    session_api_auth_session_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SessionView"];
                };
            };
        };
    };
    login_api_auth_login_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["LoginRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SessionView"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    logout_api_auth_logout_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SessionView"];
                };
            };
        };
    };
    health_health_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
        };
    };
    portfolio_api_portfolio_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Portfolio"];
                };
            };
        };
    };
    account_api_accounts__account_id__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                account_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AccountView"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    provider_status_api_providers_nebius_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProviderStatus"];
                };
            };
        };
    };
    discover_api_providers_nebius_discover_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProviderStatus"];
                };
            };
        };
    };
    analyze_api_accounts__account_id__analyze_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                account_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AnalyzeRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ModelRun"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    run_pipeline_api_pipeline_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PipelineRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PipelineRun"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_pipeline_api_pipeline__run_id__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                run_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PipelineRun"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    hubspot_readiness_api_integrations_hubspot_accounts__account_id__execution_readiness_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                account_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HubSpotExecutionReadiness"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    create_plan_api_plans_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PlanRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Plan"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    generate_plan_api_plans_generate_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PlanRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ModelRun"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_planning_run_api_plans_runs__run_id__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                run_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ModelRun"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_plan_api_plans__plan_id__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                plan_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Plan"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    list_missions_api_missions_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Mission"][];
                };
            };
        };
    };
    create_mission_api_missions_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MissionRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Mission"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_mission_api_missions__mission_id__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                mission_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Mission"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_audit_api_missions__mission_id__audit_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                mission_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AuditEvent"][];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    list_actions_api_missions__mission_id__actions_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                mission_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ActionPreview"][];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    prepare_api_missions__mission_id__prepare_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                mission_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PrepareRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ActionPreview"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    supersede_mission_api_missions__mission_id__supersede_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                mission_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SupersedeRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Mission"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_action_api_actions__action_id__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                action_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ActionPreview"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    submit_api_actions__action_id__submit_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                action_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SubmitRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ActionPreview"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    action_history_api_actions__action_id__history_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                action_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ActionPreview"][];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    renew_review_api_actions__action_id__renew_review_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                action_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SubmitRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ActionPreview"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    review_api_actions__action_id__review_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                action_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ReviewRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReviewDecision"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    list_decisions_api_actions__action_id__decisions_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                action_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReviewDecision"][];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    list_executions_api_actions__action_id__executions_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                action_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Execution"][];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    execute_api_actions__action_id__execute_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                action_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ExecuteRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Execution"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_execution_api_executions__execution_id__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                execution_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Execution"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_receipt_api_receipts__receipt_id__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                receipt_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Receipt"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    reconcile_api_executions__execution_id__reconcile_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                execution_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RevisionRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Execution"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    list_outcomes_api_missions__mission_id__outcomes_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                mission_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Outcome"][];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    outcome_api_missions__mission_id__outcomes_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                mission_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["OutcomeRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Outcome"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    retry_api_executions__execution_id__retry_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                execution_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ExecuteRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Execution"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    status_api_integrations_hubspot_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HubSpotStatus"];
                };
            };
        };
    };
    sync_api_integrations_hubspot_accounts__account_id__sync_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                account_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["HubSpotSyncRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HubSpotSyncRun"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_run_api_integrations_hubspot_runs__run_id__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                run_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HubSpotSyncRun"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_observation_api_integrations_hubspot_observations__observation_id__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                observation_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HubSpotObservation"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    preview_api_integrations_hubspot_accounts__account_id__preview_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                account_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HubSpotPreview"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    promote_api_integrations_hubspot_accounts__account_id__promote_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                account_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["HubSpotPromoteRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AccountSource"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    restore_sample_api_integrations_hubspot_accounts__account_id__restore_sample_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                account_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["HubSpotSyncRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AccountSource"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    source_version_api_integrations_hubspot_sources__source_id__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                source_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AccountSourceVersion"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
}
