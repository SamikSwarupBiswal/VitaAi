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
            annual_value: number;
            /**
             * Renewal Date
             * Format: date
             */
            renewal_date: string;
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
            renewal_days: number;
            latest_run?: components["schemas"]["ModelRun"] | null;
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
            task: "analysis" | "drafts";
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
             * @constant
             */
            mode: "local_sample";
            /**
             * As Of
             * Format: date
             */
            as_of: string;
            /** Annual Value */
            annual_value: number;
            /** Attention Count */
            attention_count: number;
            /** Growth Count */
            growth_count: number;
            /** Accounts */
            accounts: components["schemas"]["AccountView"][];
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
}
