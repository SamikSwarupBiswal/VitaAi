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
    "/api/integrations/microsoft": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Microsoft Status */
        get: operations["microsoft_status_api_integrations_microsoft_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/integrations/microsoft/connect": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Microsoft Connect */
        post: operations["microsoft_connect_api_integrations_microsoft_connect_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/integrations/microsoft/callback": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Microsoft Callback */
        get: operations["microsoft_callback_api_integrations_microsoft_callback_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/integrations/microsoft/signout": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Microsoft Signout */
        post: operations["microsoft_signout_api_integrations_microsoft_signout_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/integrations/microsoft/refresh": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Microsoft Refresh */
        post: operations["microsoft_refresh_api_integrations_microsoft_refresh_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/integrations/microsoft/missions/{mission_id}/execution-readiness": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Microsoft Readiness */
        get: operations["microsoft_readiness_api_integrations_microsoft_missions__mission_id__execution_readiness_get"];
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
    "/api/integrations/hubspot/detections/{detection_id}/mission": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Source Mission */
        get: operations["source_mission_api_integrations_hubspot_detections__detection_id__mission_get"];
        put?: never;
        /** Select Source Mission */
        post: operations["select_source_mission_api_integrations_hubspot_detections__detection_id__mission_post"];
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
    "/api/missions/{mission_id}/coaching-reviews": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List Coaching Reviews */
        get: operations["list_coaching_reviews_api_missions__mission_id__coaching_reviews_get"];
        put?: never;
        /** Review Coaching */
        post: operations["review_coaching_api_missions__mission_id__coaching_reviews_post"];
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
    "/api/integrations/hubspot/accounts/{account_id}/connection-readiness": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Connection Readiness */
        get: operations["connection_readiness_api_integrations_hubspot_accounts__account_id__connection_readiness_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/integrations/hubspot/accounts/{account_id}/probe": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Probe Connection */
        post: operations["probe_connection_api_integrations_hubspot_accounts__account_id__probe_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/integrations/hubspot/accounts/{account_id}/seed-preview": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Seed Preview */
        post: operations["seed_preview_api_integrations_hubspot_accounts__account_id__seed_preview_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/integrations/hubspot/accounts/{account_id}/ingestions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Ingestion History */
        get: operations["ingestion_history_api_integrations_hubspot_accounts__account_id__ingestions_get"];
        put?: never;
        /** Ingest */
        post: operations["ingest_api_integrations_hubspot_accounts__account_id__ingestions_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/integrations/hubspot/accounts/{account_id}/ingestions/readiness": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Ingestion Readiness */
        get: operations["ingestion_readiness_api_integrations_hubspot_accounts__account_id__ingestions_readiness_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/integrations/hubspot/ingestions/{record_id}/recovery-readiness": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Ingestion Recovery Readiness */
        get: operations["ingestion_recovery_readiness_api_integrations_hubspot_ingestions__record_id__recovery_readiness_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/integrations/hubspot/ingestions/{record_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Ingestion Record */
        get: operations["ingestion_record_api_integrations_hubspot_ingestions__record_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/integrations/hubspot/ingestions/{record_id}/recover": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Ingestion Recover */
        post: operations["ingestion_recover_api_integrations_hubspot_ingestions__record_id__recover_post"];
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
    "/api/integrations/hubspot/accounts/{account_id}/refresh-schedule": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Refresh Schedule */
        get: operations["refresh_schedule_api_integrations_hubspot_accounts__account_id__refresh_schedule_get"];
        put?: never;
        /** Authorize Refresh */
        post: operations["authorize_refresh_api_integrations_hubspot_accounts__account_id__refresh_schedule_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/integrations/hubspot/accounts/{account_id}/refresh-schedule/revoke": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Revoke Refresh */
        post: operations["revoke_refresh_api_integrations_hubspot_accounts__account_id__refresh_schedule_revoke_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/integrations/hubspot/accounts/{account_id}/refresh-occurrences": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Refresh History */
        get: operations["refresh_history_api_integrations_hubspot_accounts__account_id__refresh_occurrences_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/integrations/hubspot/refresh-occurrences/{record_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Refresh Occurrence */
        get: operations["refresh_occurrence_api_integrations_hubspot_refresh_occurrences__record_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/integrations/hubspot/refresh-occurrences/{record_id}/recovery-readiness": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Refresh Recovery Readiness */
        get: operations["refresh_recovery_readiness_api_integrations_hubspot_refresh_occurrences__record_id__recovery_readiness_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/integrations/hubspot/refresh-occurrences/{record_id}/recover": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Refresh Recover */
        post: operations["refresh_recover_api_integrations_hubspot_refresh_occurrences__record_id__recover_post"];
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
    "/api/integrations/hubspot/accounts/{account_id}/detect-changes": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Detect Changes */
        post: operations["detect_changes_api_integrations_hubspot_accounts__account_id__detect_changes_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/integrations/hubspot/accounts/{account_id}/detections": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Detection History */
        get: operations["detection_history_api_integrations_hubspot_accounts__account_id__detections_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/integrations/hubspot/detections/{detection_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Detection */
        get: operations["detection_api_integrations_hubspot_detections__detection_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/integrations/research": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Status */
        get: operations["status_api_integrations_research_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/integrations/research/accounts/{account_id}/search": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Search */
        post: operations["search_api_integrations_research_accounts__account_id__search_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/integrations/research/runs/{run_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Run */
        get: operations["get_run_api_integrations_research_runs__run_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/integrations/research/runs/{run_id}/context": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Context */
        get: operations["context_api_integrations_research_runs__run_id__context_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/integrations/research/runs/{run_id}/recovery-readiness": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Recovery Readiness */
        get: operations["recovery_readiness_api_integrations_research_runs__run_id__recovery_readiness_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/integrations/research/runs/{run_id}/recover": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Recover */
        post: operations["recover_api_integrations_research_runs__run_id__recover_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/integrations/research/accounts/{account_id}/readiness": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Readiness */
        get: operations["readiness_api_integrations_research_accounts__account_id__readiness_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/integrations/research/accounts/{account_id}/runs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** History */
        get: operations["history_api_integrations_research_accounts__account_id__runs_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/integrations/research/runs/{run_id}/narrative-readiness": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Readiness */
        get: operations["readiness_api_integrations_research_runs__run_id__narrative_readiness_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/integrations/research/runs/{run_id}/narratives": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** History */
        get: operations["history_api_integrations_research_runs__run_id__narratives_get"];
        put?: never;
        /** Start */
        post: operations["start_api_integrations_research_runs__run_id__narratives_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/integrations/research/narratives/{narrative_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get */
        get: operations["get_api_integrations_research_narratives__narrative_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/integrations/research/narratives/{narrative_id}/recovery-readiness": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Recovery Readiness */
        get: operations["recovery_readiness_api_integrations_research_narratives__narrative_id__recovery_readiness_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/integrations/research/narratives/{narrative_id}/recover": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Recover */
        post: operations["recover_api_integrations_research_narratives__narrative_id__recover_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/provider-comparison/catalog": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Entries */
        get: operations["entries_api_provider_comparison_catalog_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/provider-comparison/providers/{provider}/discover": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Discover */
        post: operations["discover_api_provider_comparison_providers__provider__discover_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/provider-comparison/accounts/{account_id}/readiness": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Readiness */
        get: operations["readiness_api_provider_comparison_accounts__account_id__readiness_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/provider-comparison/accounts/{account_id}/compare": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Compare */
        post: operations["compare_api_provider_comparison_accounts__account_id__compare_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/provider-comparison/runs/{run_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get */
        get: operations["get_api_provider_comparison_runs__run_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/provider-comparison/runs/{run_id}/recovery-readiness": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Recovery Readiness */
        get: operations["recovery_readiness_api_provider_comparison_runs__run_id__recovery_readiness_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/provider-comparison/runs/{run_id}/recover": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Recover */
        post: operations["recover_api_provider_comparison_runs__run_id__recover_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/provider-comparison/accounts/{account_id}/runs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** History */
        get: operations["history_api_provider_comparison_accounts__account_id__runs_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/provider-comparison/providers/{provider}/test-readiness": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Readiness */
        get: operations["readiness_api_provider_comparison_providers__provider__test_readiness_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/provider-comparison/providers/{provider}/test": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Start */
        post: operations["start_api_provider_comparison_providers__provider__test_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/provider-comparison/tests/{run_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get */
        get: operations["get_api_provider_comparison_tests__run_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/provider-comparison/tests/{run_id}/recovery-readiness": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Recovery Readiness */
        get: operations["recovery_readiness_api_provider_comparison_tests__run_id__recovery_readiness_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/provider-comparison/tests/{run_id}/recover": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Recover */
        post: operations["recover_api_provider_comparison_tests__run_id__recover_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/provider-comparison/providers/{provider}/tests": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** History */
        get: operations["history_api_provider_comparison_providers__provider__tests_get"];
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
        /** AssociatedObject */
        AssociatedObject: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /** Object Id */
            object_id: string;
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
            /**
             * Updated At
             * Format: date-time
             */
            updated_at: string;
            /** Properties */
            properties: {
                [key: string]: string | null;
            };
            /** Association Types */
            association_types: components["schemas"]["AssociationType"][];
        };
        /** AssociationType */
        AssociationType: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /**
             * Category
             * @enum {string}
             */
            category: "HUBSPOT_DEFINED" | "USER_DEFINED" | "INTEGRATOR_DEFINED";
            /** Type Id */
            type_id: number;
            /** Label */
            label: string | null;
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
        /** CatalogEntry */
        CatalogEntry: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /**
             * Provider
             * @enum {string}
             */
            provider: "nebius" | "openai" | "anthropic" | "nvidia" | "foundry";
            /** Enabled */
            enabled: boolean;
            /** Live Configured */
            live_configured: boolean;
            /** Configuration Revision */
            configuration_revision: number;
            /** Model */
            model: string | null;
            /** Expected Response Model */
            expected_response_model: string | null;
            /**
             * Status
             * @enum {string}
             */
            status: "disabled" | "unconfigured" | "configured_unverified";
            /** Capabilities */
            capabilities: ("model_discovery" | "account_analysis")[];
            /**
             * Byok Allowed
             * @default false
             */
            byok_allowed: boolean;
        };
        /** CoachingRequest */
        CoachingRequest: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /** Expected Revision */
            expected_revision: number;
            /** Expected Mission Revision */
            expected_mission_revision: number;
            /**
             * Outcome Id
             * Format: uuid
             */
            outcome_id: string;
            /** Expected Outcome Revision */
            expected_outcome_revision: number;
            /**
             * Status
             * @enum {string}
             */
            status: "reviewed" | "revision_required";
            /** Note */
            note: string;
        };
        /** CoachingReview */
        CoachingReview: {
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
             * Outcome Id
             * Format: uuid
             */
            outcome_id: string;
            /** Outcome Revision */
            outcome_revision: number;
            /** Reviewer Id */
            reviewer_id: string;
            /**
             * Status
             * @enum {string}
             */
            status: "reviewed" | "revision_required";
            /** Note */
            note: string;
            /** Supersedes Id */
            supersedes_id?: string | null;
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
        /** ComparisonChoice */
        ComparisonChoice: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /**
             * Provider
             * @enum {string}
             */
            provider: "nebius" | "openai" | "anthropic" | "nvidia" | "foundry";
            /**
             * Mode
             * @default mock
             * @enum {string}
             */
            mode: "mock" | "live";
            /** Expected Configuration Revision */
            expected_configuration_revision: number;
            /** Api Key */
            api_key?: string | null;
        };
        /** ComparisonReadiness */
        ComparisonReadiness: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /** Organization Id */
            organization_id: string;
            /**
             * Account Id
             * Format: uuid
             */
            account_id: string;
            /** Account Revision */
            account_revision: number;
            /** Snapshot Hash */
            snapshot_hash: string;
            /** Configured */
            configured: boolean;
            /** Can Start */
            can_start: boolean;
            /** Pending Run Id */
            pending_run_id: string | null;
            /** Next Start At */
            next_start_at: string | null;
        };
        /** ComparisonRecovery */
        ComparisonRecovery: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /** Actor Id */
            actor_id: string;
            /**
             * Recovered At
             * Format: date-time
             */
            recovered_at: string;
            /** Previous Revision */
            previous_revision: number;
            /**
             * Reason
             * @default worker_deadline_elapsed
             * @constant
             */
            reason: "worker_deadline_elapsed";
        };
        /** ComparisonRecoveryReadiness */
        ComparisonRecoveryReadiness: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /** Organization Id */
            organization_id: string;
            /**
             * Account Id
             * Format: uuid
             */
            account_id: string;
            /** Account Revision */
            account_revision: number;
            /** Snapshot Hash */
            snapshot_hash: string;
            /**
             * Run Id
             * Format: uuid
             */
            run_id: string;
            /** Run Revision */
            run_revision: number;
            /** Can Recover */
            can_recover: boolean;
            /**
             * Reason
             * @enum {string}
             */
            reason: "eligible" | "role_denied" | "terminal" | "legacy_worker" | "worker_active";
            /** Recover After */
            recover_after: string | null;
        };
        /** ComparisonRecoveryRequest */
        ComparisonRecoveryRequest: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /** Expected Revision */
            expected_revision: number;
            /** Expected Account Revision */
            expected_account_revision: number;
            /** Expected Snapshot Hash */
            expected_snapshot_hash: string;
        };
        /** ComparisonRequest */
        ComparisonRequest: {
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
            /** Providers */
            providers: components["schemas"]["ComparisonChoice"][];
        };
        /** ComparisonResult */
        ComparisonResult: {
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
            id?: string;
            /**
             * Provider
             * @enum {string}
             */
            provider: "nebius" | "openai" | "anthropic" | "nvidia" | "foundry";
            /**
             * Requested Mode
             * @enum {string}
             */
            requested_mode: "mock" | "live";
            /**
             * Mode
             * @enum {string}
             */
            mode: "disabled" | "mock" | "live" | "fallback";
            /** Configuration Revision */
            configuration_revision: number;
            /** Model */
            model: string | null;
            /** Expected Response Model */
            expected_response_model: string | null;
            /** Response Model */
            response_model?: string | null;
            /**
             * Status
             * @default pending
             * @enum {string}
             */
            status: "pending" | "succeeded" | "unavailable" | "failed" | "invalid_output" | "discarded";
            /**
             * Validation
             * @default not_run
             * @enum {string}
             */
            validation: "not_run" | "rejected" | "schema_and_references_valid";
            /**
             * Factual Confidence
             * @default unverified
             * @constant
             */
            factual_confidence: "unverified";
            /** Started At */
            started_at?: string | null;
            /** Finished At */
            finished_at?: string | null;
            /** Latency Ms */
            latency_ms?: number | null;
            /** Request Id */
            request_id?: string | null;
            /** Input Tokens */
            input_tokens?: number | null;
            /** Output Tokens */
            output_tokens?: number | null;
            /** Error Code */
            error_code?: string | null;
            analysis?: components["schemas"]["Analysis"] | null;
            /**
             * Credential Source
             * @default server
             * @enum {string}
             */
            credential_source: "server" | "request";
        };
        /** ComparisonRun */
        ComparisonRun: {
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
            account_revision: number;
            /** Snapshot Hash */
            snapshot_hash: string;
            /**
             * Policy Version
             * @default comparison-1
             * @constant
             */
            policy_version: "comparison-1";
            /**
             * Status
             * @default pending
             * @enum {string}
             */
            status: "pending" | "completed" | "discarded" | "interrupted";
            /**
             * Revision
             * @default 1
             */
            revision: number;
            /** Worker Deadline At */
            worker_deadline_at?: string | null;
            recovery?: components["schemas"]["ComparisonRecovery"] | null;
            /**
             * Started At
             * Format: date-time
             */
            started_at: string;
            /** Finished At */
            finished_at?: string | null;
            snapshot: components["schemas"]["AccountView"];
            /** Results */
            results: components["schemas"]["ComparisonResult"][];
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
        /** DiscoveryRequest */
        DiscoveryRequest: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /**
             * Mode
             * @default mock
             * @enum {string}
             */
            mode: "mock" | "live";
            /** Expected Configuration Revision */
            expected_configuration_revision?: number | null;
            /** Api Key */
            api_key?: string | null;
        };
        /** DiscoveryResult */
        DiscoveryResult: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /**
             * Provider
             * @enum {string}
             */
            provider: "nebius" | "openai" | "anthropic" | "nvidia" | "foundry";
            /**
             * Requested Mode
             * @enum {string}
             */
            requested_mode: "mock" | "live";
            /**
             * Mode
             * @enum {string}
             */
            mode: "disabled" | "mock" | "live" | "fallback";
            /**
             * Source
             * @enum {string}
             */
            source: "configuration" | "provider" | "none";
            /** Configuration Revision */
            configuration_revision: number;
            /**
             * Observed At
             * Format: date-time
             */
            observed_at: string;
            /** Models */
            models?: string[];
            /**
             * Has More
             * @default false
             */
            has_more: boolean;
            /** Error Code */
            error_code?: string | null;
            /**
             * Credential Source
             * @default server
             * @enum {string}
             */
            credential_source: "server" | "request";
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
        /** HubSpotProbeReadiness */
        HubSpotProbeReadiness: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /** Organization Id */
            organization_id: string;
            /**
             * Account Id
             * Format: uuid
             */
            account_id: string;
            /** Account Revision */
            account_revision: number;
            /** Configuration Hash */
            configuration_hash: string;
            /** Can Probe */
            can_probe: boolean;
            /**
             * Reason
             * @enum {string}
             */
            reason: "ready" | "probe_disabled" | "admin_required" | "unconfigured";
        };
        /** HubSpotProbeRequest */
        HubSpotProbeRequest: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /** Expected Account Revision */
            expected_account_revision: number;
            /** Expected Configuration Hash */
            expected_configuration_hash: string;
        };
        /** HubSpotProbeResult */
        HubSpotProbeResult: {
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
            /** Actor Id */
            actor_id: string;
            /** Configuration Hash */
            configuration_hash: string;
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
            /** Error Code */
            error_code?: string | null;
            /**
             * Policy
             * @default ephemeral-mapped-company-probe-1
             * @constant
             */
            policy: "ephemeral-mapped-company-probe-1";
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
        /** IngestionReadiness */
        IngestionReadiness: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /** Organization Id */
            organization_id: string;
            /**
             * Account Id
             * Format: uuid
             */
            account_id: string;
            /** Account Revision */
            account_revision: number;
            /** Configuration Revision */
            configuration_revision: number;
            /** Configuration Hash */
            configuration_hash: string;
            /** Connector Configured */
            connector_configured: boolean;
            /** Ingestion Enabled */
            ingestion_enabled: boolean;
            /** Can Start */
            can_start: boolean;
            /**
             * Reason
             * @enum {string}
             */
            reason: "ready" | "administrator_required" | "hubspot_unconfigured" | "hubspot_ingestion_disabled" | "company_mapping_unavailable" | "ingestion_pending" | "ingestion_cooldown";
            /** Pending Run Id */
            pending_run_id?: string | null;
            /** Cooldown Until */
            cooldown_until?: string | null;
        };
        /** IngestionRecovery */
        IngestionRecovery: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /** Expected Revision */
            expected_revision: number;
            /** Expected Account Revision */
            expected_account_revision: number;
            /**
             * Expected Worker Deadline At
             * Format: date-time
             */
            expected_worker_deadline_at: string;
        };
        /** IngestionRecoveryReadiness */
        IngestionRecoveryReadiness: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            run: components["schemas"]["IngestionRun"];
            /** Account Revision */
            account_revision: number;
            /** Eligible */
            eligible: boolean;
            /**
             * Reason
             * @enum {string}
             */
            reason: "eligible" | "administrator_required" | "not_pending" | "worker_active";
        };
        /** IngestionRequest */
        IngestionRequest: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /** Expected Account Revision */
            expected_account_revision: number;
            /** Expected Configuration Revision */
            expected_configuration_revision: number;
            /** Expected Configuration Hash */
            expected_configuration_hash: string;
            /**
             * Object Type
             * @enum {string}
             */
            object_type: "contacts" | "deals" | "notes" | "tasks" | "calls" | "meetings" | "emails";
        };
        /** IngestionRun */
        IngestionRun: {
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
            /** Actor Id */
            actor_id: string;
            /** Portal Id */
            portal_id: string;
            /** Company Id */
            company_id: string;
            /** Configuration Revision */
            configuration_revision: number;
            /** Configuration Hash */
            configuration_hash?: string | null;
            /**
             * Object Type
             * @enum {string}
             */
            object_type: "contacts" | "deals" | "notes" | "tasks" | "calls" | "meetings" | "emails";
            /** Sequence */
            sequence: number;
            /**
             * Revision
             * @default 1
             */
            revision: number;
            /**
             * Started At
             * Format: date-time
             */
            started_at: string;
            /**
             * Worker Deadline At
             * Format: date-time
             */
            worker_deadline_at: string;
            /** Finished At */
            finished_at?: string | null;
            /**
             * Status
             * @default pending
             * @enum {string}
             */
            status: "pending" | "succeeded" | "failed" | "interrupted";
            /** Error Code */
            error_code?: string | null;
            /** Fingerprint */
            fingerprint?: string | null;
            /** Disposition */
            disposition?: ("baseline" | "unchanged" | "changed") | null;
            /** Previous Run Id */
            previous_run_id?: string | null;
            /** Objects */
            objects?: components["schemas"]["AssociatedObject"][];
            /** Recovered By */
            recovered_by?: string | null;
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
        /** MicrosoftActionReadiness */
        MicrosoftActionReadiness: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /**
             * Action Id
             * Format: uuid
             */
            action_id: string;
            /** Action Revision */
            action_revision: number;
            /** Binding Hash */
            binding_hash: string;
            /** Can Write */
            can_write: boolean;
            /** Can Reconcile */
            can_reconcile: boolean;
        };
        /** MicrosoftExecutionReadiness */
        MicrosoftExecutionReadiness: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /**
             * Mission Id
             * Format: uuid
             */
            mission_id: string;
            /** Mission Revision */
            mission_revision: number;
            /**
             * Account Id
             * Format: uuid
             */
            account_id: string;
            /** Account Revision */
            account_revision: number;
            /** Organization Id */
            organization_id: string;
            /** Can Prepare */
            can_prepare: boolean;
            destination: components["schemas"]["DestinationBinding"] | null;
            /** Actions */
            actions: components["schemas"]["MicrosoftActionReadiness"][];
        };
        /** MicrosoftRefreshRequest */
        MicrosoftRefreshRequest: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /**
             * Binding Id
             * Format: uuid
             */
            binding_id: string;
        };
        /** MicrosoftStart */
        MicrosoftStart: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /** Authorization Url */
            authorization_url: string;
        };
        /** MicrosoftStatus */
        MicrosoftStatus: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /** Configured */
            configured: boolean;
            /** Connected */
            connected: boolean;
            /** Write Configured */
            write_configured: boolean;
            /** Binding Id */
            binding_id?: string | null;
            /** Mailbox Id */
            mailbox_id?: string | null;
            /** Expires At */
            expires_at?: number | null;
            /** Connection Origin */
            connection_origin: string;
            /** Refresh Binding Id */
            refresh_binding_id?: string | null;
            /**
             * Can Refresh
             * @default false
             */
            can_refresh: boolean;
            /**
             * Refresh Pending
             * @default false
             */
            refresh_pending: boolean;
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
            /** Source Detection Id */
            source_detection_id?: string | null;
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
        /** NarrativeHypothesis */
        NarrativeHypothesis: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /** Interpretation */
            interpretation: string;
            /** Verification Question */
            verification_question: string;
            /** Evidence Ids */
            evidence_ids: string[];
            /** Source Urls */
            source_urls: string[];
        };
        /** NarrativeOutput */
        NarrativeOutput: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /** Hypotheses */
            hypotheses: components["schemas"]["NarrativeHypothesis"][];
            /** Caveats */
            caveats: string[];
        };
        /** NarrativeReadiness */
        NarrativeReadiness: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /** Organization Id */
            organization_id: string;
            /**
             * Account Id
             * Format: uuid
             */
            account_id: string;
            /** Account Revision */
            account_revision: number;
            /** Snapshot Hash */
            snapshot_hash: string;
            /**
             * Research Run Id
             * Format: uuid
             */
            research_run_id: string;
            /** Research Run Revision */
            research_run_revision: number;
            /** Context Status */
            context_status: string;
            /** Configuration Revision */
            configuration_revision: number;
            /** Enabled */
            enabled: boolean;
            /** Live Configured */
            live_configured: boolean;
            /** Model */
            model: string | null;
            /** Can Start */
            can_start: boolean;
            /** Pending Run Id */
            pending_run_id: string | null;
            /** Next Start At */
            next_start_at: string | null;
        };
        /** NarrativeRequest */
        NarrativeRequest: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /** Expected Account Revision */
            expected_account_revision: number;
            /** Expected Snapshot Hash */
            expected_snapshot_hash: string;
            /** Expected Run Revision */
            expected_run_revision: number;
            /** Expected Configuration Revision */
            expected_configuration_revision: number;
            /**
             * Mode
             * @default mock
             * @enum {string}
             */
            mode: "mock" | "live";
        };
        /** NarrativeRun */
        NarrativeRun: {
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
            /**
             * Research Run Id
             * Format: uuid
             */
            research_run_id: string;
            /**
             * Policy Version
             * @default research-narrative-1
             * @constant
             */
            policy_version: "research-narrative-1";
            /**
             * Revision
             * @default 1
             */
            revision: number;
            context: components["schemas"]["ResearchContext"];
            /**
             * Provider
             * @default nebius
             * @constant
             */
            provider: "nebius";
            /** Configuration Revision */
            configuration_revision: number;
            /** Model */
            model: string | null;
            /** Expected Response Model */
            expected_response_model: string | null;
            /** Response Model */
            response_model?: string | null;
            /**
             * Requested Mode
             * @enum {string}
             */
            requested_mode: "mock" | "live";
            /**
             * Mode
             * @enum {string}
             */
            mode: "disabled" | "mock" | "live" | "fallback";
            /**
             * Status
             * @default pending
             * @enum {string}
             */
            status: "pending" | "succeeded" | "unavailable" | "failed" | "invalid_output" | "discarded" | "interrupted";
            recovery?: components["schemas"]["ResearchRecovery"] | null;
            /**
             * Validation
             * @default not_run
             * @enum {string}
             */
            validation: "not_run" | "rejected" | "schema_and_references_valid";
            /**
             * Factual Confidence
             * @default unverified
             * @constant
             */
            factual_confidence: "unverified";
            /**
             * Started At
             * Format: date-time
             */
            started_at: string;
            /**
             * Worker Deadline At
             * Format: date-time
             */
            worker_deadline_at: string;
            /** Finished At */
            finished_at?: string | null;
            /** Latency Ms */
            latency_ms?: number | null;
            /** Request Id */
            request_id?: string | null;
            /** Input Tokens */
            input_tokens?: number | null;
            /** Output Tokens */
            output_tokens?: number | null;
            /** Error Code */
            error_code?: string | null;
            output?: components["schemas"]["NarrativeOutput"] | null;
            /**
             * Caveat
             * @default Generated interpretations are unverified hypotheses for human review. Schema and citation validation does not establish truth, account identity, causality, approval or business outcomes. The retained internal baseline and caveats remain authoritative; research changes no facts or authority.
             */
            caveat: string;
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
        /** ProbeReadiness */
        ProbeReadiness: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /** Organization Id */
            organization_id: string;
            /**
             * Provider
             * @enum {string}
             */
            provider: "nebius" | "openai" | "anthropic" | "nvidia" | "foundry";
            /** Configuration Revision */
            configuration_revision: number;
            /** Model */
            model: string | null;
            /** Expected Response Model */
            expected_response_model: string | null;
            /** Can Start */
            can_start: boolean;
            /** Live Configured */
            live_configured: boolean;
            /** Byok Allowed */
            byok_allowed: boolean;
            /** Pending Run Id */
            pending_run_id: string | null;
            /** Next Start At */
            next_start_at: string | null;
        };
        /** ProbeRecovery */
        ProbeRecovery: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /** Actor Id */
            actor_id: string;
            /**
             * Recovered At
             * Format: date-time
             */
            recovered_at: string;
            /** Previous Revision */
            previous_revision: number;
            /**
             * Reason
             * @default worker_deadline_elapsed
             * @constant
             */
            reason: "worker_deadline_elapsed";
        };
        /** ProbeRecoveryReadiness */
        ProbeRecoveryReadiness: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /** Organization Id */
            organization_id: string;
            /**
             * Provider
             * @enum {string}
             */
            provider: "nebius" | "openai" | "anthropic" | "nvidia" | "foundry";
            /**
             * Run Id
             * Format: uuid
             */
            run_id: string;
            /** Run Revision */
            run_revision: number;
            /**
             * Worker Deadline At
             * Format: date-time
             */
            worker_deadline_at: string;
            /** Can Recover */
            can_recover: boolean;
            /**
             * Reason
             * @enum {string}
             */
            reason: "eligible" | "role_denied" | "terminal" | "worker_active";
        };
        /** ProbeRecoveryRequest */
        ProbeRecoveryRequest: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /**
             * Expected Provider
             * @enum {string}
             */
            expected_provider: "nebius" | "openai" | "anthropic" | "nvidia" | "foundry";
            /** Expected Revision */
            expected_revision: number;
            /**
             * Expected Worker Deadline At
             * Format: date-time
             */
            expected_worker_deadline_at: string;
        };
        /** ProbeRequest */
        ProbeRequest: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /**
             * Mode
             * @default mock
             * @enum {string}
             */
            mode: "mock" | "live";
            /** Expected Configuration Revision */
            expected_configuration_revision: number;
            /** Api Key */
            api_key?: string | null;
        };
        /** ProbeRun */
        ProbeRun: {
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
            /** Actor Id */
            actor_id: string;
            /**
             * Provider
             * @enum {string}
             */
            provider: "nebius" | "openai" | "anthropic" | "nvidia" | "foundry";
            /**
             * Policy Version
             * @default synthetic-probe-1
             * @constant
             */
            policy_version: "synthetic-probe-1";
            /**
             * Revision
             * @default 1
             */
            revision: number;
            /** Configuration Revision */
            configuration_revision: number;
            /** Model */
            model: string | null;
            /** Expected Response Model */
            expected_response_model: string | null;
            /** Response Model */
            response_model?: string | null;
            /**
             * Credential Source
             * @enum {string}
             */
            credential_source: "server" | "request";
            /**
             * Requested Mode
             * @enum {string}
             */
            requested_mode: "mock" | "live";
            /**
             * Mode
             * @enum {string}
             */
            mode: "disabled" | "mock" | "live" | "fallback";
            /**
             * Status
             * @default pending
             * @enum {string}
             */
            status: "pending" | "succeeded" | "unavailable" | "failed" | "invalid_output" | "discarded" | "interrupted";
            /**
             * Validation
             * @default not_run
             * @enum {string}
             */
            validation: "not_run" | "rejected" | "synthetic_compatibility_valid";
            /**
             * Started At
             * Format: date-time
             */
            started_at: string;
            /**
             * Worker Deadline At
             * Format: date-time
             */
            worker_deadline_at: string;
            /** Finished At */
            finished_at?: string | null;
            /** Latency Ms */
            latency_ms?: number | null;
            /** Request Id */
            request_id?: string | null;
            /** Input Tokens */
            input_tokens?: number | null;
            /** Output Tokens */
            output_tokens?: number | null;
            /** Error Code */
            error_code?: string | null;
            recovery?: components["schemas"]["ProbeRecovery"] | null;
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
        /** RefreshAuthorization */
        RefreshAuthorization: {
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
            /** Revision */
            revision: number;
            /**
             * Status
             * @enum {string}
             */
            status: "authorized" | "revoked";
            /** Actor Id */
            actor_id: string;
            /**
             * Recorded At
             * Format: date-time
             */
            recorded_at: string;
            /** Account Revision */
            account_revision: number;
            /** Configuration Hash */
            configuration_hash: string;
            /** Portal Id */
            portal_id: string;
            /** Company Id */
            company_id: string;
            /** Configuration Revision */
            configuration_revision: number;
            /** Mapping Hash */
            mapping_hash: string;
            /** Interval Seconds */
            interval_seconds: number;
            /**
             * Authorized At
             * Format: date-time
             */
            authorized_at: string;
            /**
             * Expires At
             * Format: date-time
             */
            expires_at: string;
            /**
             * First Due At
             * Format: date-time
             */
            first_due_at: string;
            /** Previous Id */
            previous_id?: string | null;
            /**
             * Policy
             * @default hubspot-staging-refresh-1
             * @constant
             */
            policy: "hubspot-staging-refresh-1";
        };
        /** RefreshGrantRequest */
        RefreshGrantRequest: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /** Expected Revision */
            expected_revision: number;
            /** Expected Account Revision */
            expected_account_revision: number;
            /** Expected Configuration Hash */
            expected_configuration_hash: string;
            /** Interval Seconds */
            interval_seconds: number;
            /** Duration Seconds */
            duration_seconds: number;
        };
        /** RefreshOccurrence */
        RefreshOccurrence: {
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
            /**
             * Authorization Id
             * Format: uuid
             */
            authorization_id: string;
            /** Authorization Revision */
            authorization_revision: number;
            /** Slot */
            slot: number;
            /**
             * Due At
             * Format: date-time
             */
            due_at: string;
            /**
             * Started At
             * Format: date-time
             */
            started_at: string;
            /**
             * Worker Deadline At
             * Format: date-time
             */
            worker_deadline_at: string;
            /**
             * Sync Run Id
             * Format: uuid
             */
            sync_run_id: string;
            /**
             * Revision
             * @default 1
             */
            revision: number;
            /**
             * Status
             * @default pending
             * @enum {string}
             */
            status: "pending" | "succeeded" | "failed" | "interrupted";
            /** Finished At */
            finished_at?: string | null;
            /** Error Code */
            error_code?: string | null;
            /** Recovered By */
            recovered_by?: string | null;
            /** Recovered At */
            recovered_at?: string | null;
        };
        /** RefreshRecoveryReadiness */
        RefreshRecoveryReadiness: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            occurrence: components["schemas"]["RefreshOccurrence"];
            /** Account Revision */
            account_revision: number;
            /** Eligible */
            eligible: boolean;
        };
        /** RefreshRecoveryRequest */
        RefreshRecoveryRequest: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /** Expected Revision */
            expected_revision: number;
            /** Expected Account Revision */
            expected_account_revision: number;
            /**
             * Expected Worker Deadline At
             * Format: date-time
             */
            expected_worker_deadline_at: string;
        };
        /** RefreshRevokeRequest */
        RefreshRevokeRequest: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /** Expected Revision */
            expected_revision: number;
        };
        /** RefreshScheduleView */
        RefreshScheduleView: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /** Organization Id */
            organization_id: string;
            /**
             * Account Id
             * Format: uuid
             */
            account_id: string;
            /** Account Revision */
            account_revision: number;
            /** Configuration Hash */
            configuration_hash: string;
            authorization: components["schemas"]["RefreshAuthorization"] | null;
            /** Can Authorize */
            can_authorize: boolean;
            /**
             * Worker Available
             * @default false
             */
            worker_available: boolean;
            /** Pending Occurrence Id */
            pending_occurrence_id?: string | null;
        };
        /** ResearchBrief */
        ResearchBrief: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /**
             * Policy Version
             * @default research-brief-1
             * @constant
             */
            policy_version: "research-brief-1";
            /**
             * Basis
             * @enum {string}
             */
            basis: "internal_only" | "supporting_context";
            /** Internal Summary */
            internal_summary: string;
            /** Internal Evidence Ids */
            internal_evidence_ids: string[];
            /** Verification Questions */
            verification_questions?: components["schemas"]["ResearchReviewQuestion"][];
            /** Topics */
            topics?: components["schemas"]["ResearchTopic"][];
            /** Caveats */
            caveats: string[];
        };
        /** ResearchContext */
        ResearchContext: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            internal: components["schemas"]["AccountView"];
            retained_run: components["schemas"]["ResearchRun"];
            /**
             * Evaluated At
             * Format: date-time
             */
            evaluated_at: string;
            /**
             * Status
             * @enum {string}
             */
            status: "usable" | "disabled" | "mock" | "fallback" | "run_unavailable" | "account_changed" | "target_changed" | "invalid_window" | "expired" | "no_usable_sources";
            /** Usable Sources */
            usable_sources?: components["schemas"]["ResearchSource"][];
            /** Exclusions */
            exclusions?: components["schemas"]["ResearchExclusion"][];
            review_question?: components["schemas"]["ResearchReviewQuestion"] | null;
            brief?: components["schemas"]["ResearchBrief"] | null;
            /**
             * Factual Confidence
             * @default unverified
             * @constant
             */
            factual_confidence: "unverified";
            /**
             * Caveat
             * @default Research remains untrusted supporting context. Domain membership is operator-declared, not company identity or factual verification. No causal relationship, confidence uplift, score, recommendation, plan, approval or execution change is established.
             */
            caveat: string;
        };
        /** ResearchExclusion */
        ResearchExclusion: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /** Source Index */
            source_index: number;
            /** Url */
            url: string;
            /**
             * Reason
             * @enum {string}
             */
            reason: "unsafe_url" | "account_match" | "duplicate" | "unknown_publication" | "stale_publication" | "invalid_time";
        };
        /** ResearchReadiness */
        ResearchReadiness: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /** Enabled */
            enabled: boolean;
            /**
             * Live Status
             * @enum {string}
             */
            live_status: "unconfigured" | "configured_unverified";
            /**
             * Provider
             * @default tavily
             * @constant
             */
            provider: "tavily";
            /** Organization Id */
            organization_id: string;
            /**
             * Account Id
             * Format: uuid
             */
            account_id: string;
            /** Account Revision */
            account_revision: number;
            target: components["schemas"]["ResearchTarget"] | null;
            /** Can Start */
            can_start: boolean;
            /** Pending Run Id */
            pending_run_id: string | null;
            /** Next Start At */
            next_start_at: string | null;
        };
        /** ResearchRecovery */
        ResearchRecovery: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /** Actor Id */
            actor_id: string;
            /**
             * Recovered At
             * Format: date-time
             */
            recovered_at: string;
            /** Previous Revision */
            previous_revision: number;
            /**
             * Reason
             * @default worker_deadline_elapsed
             * @constant
             */
            reason: "worker_deadline_elapsed";
        };
        /** ResearchRecoveryReadiness */
        ResearchRecoveryReadiness: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /** Organization Id */
            organization_id: string;
            /**
             * Account Id
             * Format: uuid
             */
            account_id: string;
            /** Account Revision */
            account_revision: number;
            /**
             * Run Id
             * Format: uuid
             */
            run_id: string;
            /** Run Revision */
            run_revision: number;
            /** Can Recover */
            can_recover: boolean;
            /**
             * Reason
             * @enum {string}
             */
            reason: "eligible" | "role_denied" | "terminal" | "legacy_worker" | "worker_active";
            /** Recover After */
            recover_after: string | null;
        };
        /** ResearchRecoveryRequest */
        ResearchRecoveryRequest: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /** Expected Revision */
            expected_revision: number;
            /** Expected Account Revision */
            expected_account_revision: number;
        };
        /** ResearchRequest */
        ResearchRequest: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /** Expected Account Revision */
            expected_account_revision: number;
            /**
             * Mode
             * @default mock
             * @enum {string}
             */
            mode: "mock" | "live";
        };
        /** ResearchReviewQuestion */
        ResearchReviewQuestion: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /** Question */
            question: string;
            /** Evidence Ids */
            evidence_ids: string[];
            /** Source Urls */
            source_urls: string[];
        };
        /** ResearchRun */
        ResearchRun: {
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
            /** Actor Id */
            actor_id: string;
            /**
             * Provider
             * @default tavily
             * @constant
             */
            provider: "tavily";
            /**
             * Requested Mode
             * @enum {string}
             */
            requested_mode: "mock" | "live";
            /**
             * Mode
             * @enum {string}
             */
            mode: "disabled" | "mock" | "live" | "fallback";
            /**
             * Status
             * @enum {string}
             */
            status: "pending" | "succeeded" | "unavailable" | "discarded" | "interrupted";
            /**
             * Revision
             * @default 1
             */
            revision: number;
            /** Worker Deadline At */
            worker_deadline_at?: string | null;
            recovery?: components["schemas"]["ResearchRecovery"] | null;
            target: components["schemas"]["ResearchTarget"];
            /**
             * Started At
             * Format: date-time
             */
            started_at: string;
            /** Finished At */
            finished_at?: string | null;
            /** Expires At */
            expires_at?: string | null;
            /** Sources */
            sources?: components["schemas"]["ResearchSource"][];
            /** Error Code */
            error_code?: string | null;
            /**
             * Caveat
             * @default Untrusted advisory search context; verify sources. Never facts, scores, approval or execution authority.
             */
            caveat: string;
        };
        /** ResearchSource */
        ResearchSource: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /** Url */
            url: string;
            /** Title */
            title: string;
            /** Text */
            text: string;
            /** Provider Relevance */
            provider_relevance: number;
            /**
             * Match
             * @default configured_domain
             * @enum {string}
             */
            match: "configured_domain" | "configured_publisher_company_mention";
            /** Published At */
            published_at: string | null;
            /**
             * Fetched At
             * Format: date-time
             */
            fetched_at: string;
            /**
             * Freshness At Fetch
             * @enum {string}
             */
            freshness_at_fetch: "fresh" | "stale" | "unknown";
            /**
             * Factual Confidence
             * @default unverified
             * @constant
             */
            factual_confidence: "unverified";
        };
        /** ResearchStatus */
        ResearchStatus: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /** Enabled */
            enabled: boolean;
            /**
             * Live Status
             * @enum {string}
             */
            live_status: "unconfigured" | "configured_unverified";
            /**
             * Provider
             * @default tavily
             * @constant
             */
            provider: "tavily";
        };
        /** ResearchTarget */
        ResearchTarget: {
            /** Company Name */
            company_name: string;
            /** Domain */
            domain: string;
            /** Publisher Domains */
            publisher_domains?: string[];
            /** Company Aliases */
            company_aliases?: string[];
        };
        /** ResearchTopic */
        ResearchTopic: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /**
             * Policy Version
             * @default research-topics-1
             * @constant
             */
            policy_version: "research-topics-1";
            /**
             * Topic
             * @enum {string}
             */
            topic: "Financing" | "Leadership" | "Workforce" | "Regulation" | "Markets" | "Other public updates";
            /**
             * Basis
             * @default keyword_mentions
             * @constant
             */
            basis: "keyword_mentions";
            /** Source Urls */
            source_urls: string[];
            /**
             * Factual Confidence
             * @default unverified
             * @constant
             */
            factual_confidence: "unverified";
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
        /** SeedPreview */
        SeedPreview: {
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
            /** Actor Id */
            actor_id: string;
            /**
             * Account Id
             * Format: uuid
             */
            account_id: string;
            /** Account Revision */
            account_revision: number;
            /** Configuration Hash */
            configuration_hash: string;
            /** Portal Id */
            portal_id: string;
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
            /**
             * Mode
             * @default preview
             * @constant
             */
            mode: "preview";
            /**
             * Execution Available
             * @default false
             * @constant
             */
            execution_available: false;
            /**
             * Method
             * @default POST
             * @constant
             */
            method: "POST";
            /**
             * Path
             * @default /crm/v3/objects/companies
             * @constant
             */
            path: "/crm/v3/objects/companies";
            /** Companies */
            companies: components["schemas"]["SyntheticCompany"][];
            /** Preview Hash */
            preview_hash: string;
            /**
             * Policy
             * @default synthetic-company-seed-preview-1
             * @constant
             */
            policy: "synthetic-company-seed-preview-1";
        };
        /** SeedPreviewRequest */
        SeedPreviewRequest: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /** Expected Account Revision */
            expected_account_revision: number;
            /** Expected Configuration Hash */
            expected_configuration_hash: string;
            /** Count */
            count: number;
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
        /** SourceChangeEvent */
        SourceChangeEvent: {
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
            /** Fingerprint */
            fingerprint: string;
            /** Changes */
            changes: components["schemas"]["SourceFieldChange"][];
        };
        /** SourceDetection */
        SourceDetection: {
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
            /**
             * Detected At
             * Format: date-time
             */
            detected_at: string;
            /**
             * Policy Version
             * @default source-change-1
             * @constant
             */
            policy_version: "source-change-1";
            /**
             * Status
             * @enum {string}
             */
            status: "baseline" | "unchanged" | "changed" | "source_reset";
            /**
             * Reason
             * @enum {string}
             */
            reason: "first_source" | "local_sample" | "source_switch" | "source_identity_changed" | "mapping_changed" | "values_unchanged" | "values_changed";
            before: components["schemas"]["SourceSnapshot"] | null;
            after: components["schemas"]["SourceSnapshot"];
            event?: components["schemas"]["SourceChangeEvent"] | null;
        };
        /** SourceDetectionBatch */
        SourceDetectionBatch: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /** Organization Id */
            organization_id: string;
            /**
             * Account Id
             * Format: uuid
             */
            account_id: string;
            /** Account Revision */
            account_revision: number;
            /**
             * Selected Source Id
             * Format: uuid
             */
            selected_source_id: string;
            /** Processed */
            processed: components["schemas"]["SourceDetection"][];
            /** Last Processed Revision */
            last_processed_revision: number | null;
            /** Has More */
            has_more: boolean;
        };
        /** SourceDetectionRequest */
        SourceDetectionRequest: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /** Expected Account Revision */
            expected_account_revision: number;
            /**
             * Expected Source Id
             * Format: uuid
             */
            expected_source_id: string;
        };
        /** SourceField */
        SourceField: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /** Value */
            value: string | number | null;
            /**
             * Status
             * @enum {string}
             */
            status: "valid" | "missing" | "invalid" | "unconfigured";
            /** Unit */
            unit: string;
            /** Observed At */
            observed_at?: string | null;
            /** Evidence Id */
            evidence_id?: string | null;
        };
        /** SourceFieldChange */
        SourceFieldChange: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /**
             * Field
             * @enum {string}
             */
            field: "name" | "industry" | "annual_value" | "renewal_date" | "usage_change" | "support_cases" | "expansion";
            /**
             * Kind
             * @enum {string}
             */
            kind: "value_changed" | "availability_changed";
            before: components["schemas"]["SourceField"];
            after: components["schemas"]["SourceField"];
        };
        /** SourceMissionRequest */
        SourceMissionRequest: {
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
            /**
             * Event Id
             * Format: uuid
             */
            event_id: string;
            /** Expected Account Revision */
            expected_account_revision: number;
            /**
             * Expected Source Id
             * Format: uuid
             */
            expected_source_id: string;
        };
        /** SourceMissionResult */
        SourceMissionResult: {
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
            status: "mission_created" | "mission_exists";
            selection: components["schemas"]["SourceMissionSelection"];
        };
        /** SourceMissionSelection */
        SourceMissionSelection: {
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
             * Policy Version
             * @default source-mission-1
             * @constant
             */
            policy_version: "source-mission-1";
            /** Actor Id */
            actor_id: string;
            detection: components["schemas"]["SourceDetection"];
            request: components["schemas"]["SourceMissionRequest"];
            /**
             * Mission Id
             * Format: uuid
             */
            mission_id: string;
        };
        /** SourceSnapshot */
        SourceSnapshot: {
            /**
             * Schema Version
             * @default 1
             * @constant
             */
            schema_version: "1";
            /**
             * Source Version Id
             * Format: uuid
             */
            source_version_id: string;
            /** Account Revision */
            account_revision: number;
            /**
             * Kind
             * @enum {string}
             */
            kind: "hubspot" | "local_sample";
            /**
             * Selected At
             * Format: date-time
             */
            selected_at: string;
            /** Observation Id */
            observation_id?: string | null;
            /** Portal Id */
            portal_id?: string | null;
            /** Company Id */
            company_id?: string | null;
            /** Mapping Hash */
            mapping_hash?: string | null;
            /** Provider Created At */
            provider_created_at?: string | null;
            /** Provider Updated At */
            provider_updated_at?: string | null;
            /** Fetched At */
            fetched_at?: string | null;
            /** Fields */
            fields?: {
                [key: string]: components["schemas"]["SourceField"];
            };
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
        /** SyntheticCompany */
        SyntheticCompany: {
            /** Name */
            name: string;
            /** Description */
            description: string;
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
    microsoft_status_api_integrations_microsoft_get: {
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
                    "application/json": components["schemas"]["MicrosoftStatus"];
                };
            };
        };
    };
    microsoft_connect_api_integrations_microsoft_connect_post: {
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
                    "application/json": components["schemas"]["MicrosoftStart"];
                };
            };
        };
    };
    microsoft_callback_api_integrations_microsoft_callback_get: {
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
    microsoft_signout_api_integrations_microsoft_signout_post: {
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
                    "application/json": components["schemas"]["MicrosoftStatus"];
                };
            };
        };
    };
    microsoft_refresh_api_integrations_microsoft_refresh_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MicrosoftRefreshRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MicrosoftStatus"];
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
    microsoft_readiness_api_integrations_microsoft_missions__mission_id__execution_readiness_get: {
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
                    "application/json": components["schemas"]["MicrosoftExecutionReadiness"];
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
    source_mission_api_integrations_hubspot_detections__detection_id__mission_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                detection_id: string;
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
                    "application/json": components["schemas"]["SourceMissionSelection"];
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
    select_source_mission_api_integrations_hubspot_detections__detection_id__mission_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                detection_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SourceMissionRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SourceMissionResult"];
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
    list_coaching_reviews_api_missions__mission_id__coaching_reviews_get: {
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
                    "application/json": components["schemas"]["CoachingReview"][];
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
    review_coaching_api_missions__mission_id__coaching_reviews_post: {
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
                "application/json": components["schemas"]["CoachingRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CoachingReview"];
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
    connection_readiness_api_integrations_hubspot_accounts__account_id__connection_readiness_get: {
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
                    "application/json": components["schemas"]["HubSpotProbeReadiness"];
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
    probe_connection_api_integrations_hubspot_accounts__account_id__probe_post: {
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
                "application/json": components["schemas"]["HubSpotProbeRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HubSpotProbeResult"];
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
    seed_preview_api_integrations_hubspot_accounts__account_id__seed_preview_post: {
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
                "application/json": components["schemas"]["SeedPreviewRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SeedPreview"];
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
    ingestion_history_api_integrations_hubspot_accounts__account_id__ingestions_get: {
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
                    "application/json": components["schemas"]["IngestionRun"][];
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
    ingest_api_integrations_hubspot_accounts__account_id__ingestions_post: {
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
                "application/json": components["schemas"]["IngestionRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["IngestionRun"];
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
    ingestion_readiness_api_integrations_hubspot_accounts__account_id__ingestions_readiness_get: {
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
                    "application/json": components["schemas"]["IngestionReadiness"];
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
    ingestion_recovery_readiness_api_integrations_hubspot_ingestions__record_id__recovery_readiness_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                record_id: string;
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
                    "application/json": components["schemas"]["IngestionRecoveryReadiness"];
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
    ingestion_record_api_integrations_hubspot_ingestions__record_id__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                record_id: string;
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
                    "application/json": components["schemas"]["IngestionRun"];
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
    ingestion_recover_api_integrations_hubspot_ingestions__record_id__recover_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                record_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["IngestionRecovery"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["IngestionRun"];
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
    refresh_schedule_api_integrations_hubspot_accounts__account_id__refresh_schedule_get: {
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
                    "application/json": components["schemas"]["RefreshScheduleView"];
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
    authorize_refresh_api_integrations_hubspot_accounts__account_id__refresh_schedule_post: {
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
                "application/json": components["schemas"]["RefreshGrantRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RefreshAuthorization"];
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
    revoke_refresh_api_integrations_hubspot_accounts__account_id__refresh_schedule_revoke_post: {
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
                "application/json": components["schemas"]["RefreshRevokeRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RefreshAuthorization"];
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
    refresh_history_api_integrations_hubspot_accounts__account_id__refresh_occurrences_get: {
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
                    "application/json": components["schemas"]["RefreshOccurrence"][];
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
    refresh_occurrence_api_integrations_hubspot_refresh_occurrences__record_id__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                record_id: string;
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
                    "application/json": components["schemas"]["RefreshOccurrence"];
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
    refresh_recovery_readiness_api_integrations_hubspot_refresh_occurrences__record_id__recovery_readiness_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                record_id: string;
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
                    "application/json": components["schemas"]["RefreshRecoveryReadiness"];
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
    refresh_recover_api_integrations_hubspot_refresh_occurrences__record_id__recover_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                record_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RefreshRecoveryRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RefreshOccurrence"];
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
    detect_changes_api_integrations_hubspot_accounts__account_id__detect_changes_post: {
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
                "application/json": components["schemas"]["SourceDetectionRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SourceDetectionBatch"];
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
    detection_history_api_integrations_hubspot_accounts__account_id__detections_get: {
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
                    "application/json": components["schemas"]["SourceDetection"][];
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
    detection_api_integrations_hubspot_detections__detection_id__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                detection_id: string;
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
                    "application/json": components["schemas"]["SourceDetection"];
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
    status_api_integrations_research_get: {
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
                    "application/json": components["schemas"]["ResearchStatus"];
                };
            };
        };
    };
    search_api_integrations_research_accounts__account_id__search_post: {
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
                "application/json": components["schemas"]["ResearchRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ResearchRun"];
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
    get_run_api_integrations_research_runs__run_id__get: {
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
                    "application/json": components["schemas"]["ResearchRun"];
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
    context_api_integrations_research_runs__run_id__context_get: {
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
                    "application/json": components["schemas"]["ResearchContext"];
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
    recovery_readiness_api_integrations_research_runs__run_id__recovery_readiness_get: {
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
                    "application/json": components["schemas"]["ResearchRecoveryReadiness"];
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
    recover_api_integrations_research_runs__run_id__recover_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                run_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ResearchRecoveryRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ResearchRun"];
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
    readiness_api_integrations_research_accounts__account_id__readiness_get: {
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
                    "application/json": components["schemas"]["ResearchReadiness"];
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
    history_api_integrations_research_accounts__account_id__runs_get: {
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
                    "application/json": components["schemas"]["ResearchRun"][];
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
    readiness_api_integrations_research_runs__run_id__narrative_readiness_get: {
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
                    "application/json": components["schemas"]["NarrativeReadiness"];
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
    history_api_integrations_research_runs__run_id__narratives_get: {
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
                    "application/json": components["schemas"]["NarrativeRun"][];
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
    start_api_integrations_research_runs__run_id__narratives_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                run_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["NarrativeRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["NarrativeRun"];
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
    get_api_integrations_research_narratives__narrative_id__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                narrative_id: string;
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
                    "application/json": components["schemas"]["NarrativeRun"];
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
    recovery_readiness_api_integrations_research_narratives__narrative_id__recovery_readiness_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                narrative_id: string;
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
                    "application/json": components["schemas"]["ResearchRecoveryReadiness"];
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
    recover_api_integrations_research_narratives__narrative_id__recover_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                narrative_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ResearchRecoveryRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["NarrativeRun"];
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
    entries_api_provider_comparison_catalog_get: {
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
                    "application/json": components["schemas"]["CatalogEntry"][];
                };
            };
        };
    };
    discover_api_provider_comparison_providers__provider__discover_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                provider: "nebius" | "openai" | "anthropic" | "nvidia" | "foundry";
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DiscoveryRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DiscoveryResult"];
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
    readiness_api_provider_comparison_accounts__account_id__readiness_get: {
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
                    "application/json": components["schemas"]["ComparisonReadiness"];
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
    compare_api_provider_comparison_accounts__account_id__compare_post: {
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
                "application/json": components["schemas"]["ComparisonRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ComparisonRun"];
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
    get_api_provider_comparison_runs__run_id__get: {
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
                    "application/json": components["schemas"]["ComparisonRun"];
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
    recovery_readiness_api_provider_comparison_runs__run_id__recovery_readiness_get: {
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
                    "application/json": components["schemas"]["ComparisonRecoveryReadiness"];
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
    recover_api_provider_comparison_runs__run_id__recover_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                run_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ComparisonRecoveryRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ComparisonRun"];
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
    history_api_provider_comparison_accounts__account_id__runs_get: {
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
                    "application/json": components["schemas"]["ComparisonRun"][];
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
    readiness_api_provider_comparison_providers__provider__test_readiness_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                provider: "nebius" | "openai" | "anthropic" | "nvidia" | "foundry";
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
                    "application/json": components["schemas"]["ProbeReadiness"];
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
    start_api_provider_comparison_providers__provider__test_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                provider: "nebius" | "openai" | "anthropic" | "nvidia" | "foundry";
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ProbeRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProbeRun"];
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
    get_api_provider_comparison_tests__run_id__get: {
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
                    "application/json": components["schemas"]["ProbeRun"];
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
    recovery_readiness_api_provider_comparison_tests__run_id__recovery_readiness_get: {
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
                    "application/json": components["schemas"]["ProbeRecoveryReadiness"];
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
    recover_api_provider_comparison_tests__run_id__recover_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                run_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ProbeRecoveryRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProbeRun"];
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
    history_api_provider_comparison_providers__provider__tests_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                provider: "nebius" | "openai" | "anthropic" | "nvidia" | "foundry";
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
                    "application/json": components["schemas"]["ProbeRun"][];
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
