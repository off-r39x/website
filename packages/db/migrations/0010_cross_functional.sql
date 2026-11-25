-- PR-L1-1c: the Notification Request and Consistency Review Case tables (SPEC-100 §42, §43, §45.6; UCR-100-004).
-- Constraints and indexes carry explicit names (DB-ARC-007); the two partial indexes are SQL-only DDL (SPEC-100 §57,
-- DB-MIG-002). The Notification Request state is text with a named allowlist CHECK and no default, so the repository
-- always sets it (SPEC-100 §10, DB-STA-001..002, EML-DB-001, plan U-6). notification_type and reason_code are text
-- without an allowlist CHECK, as §42 and §43 define them; the repository input closes them (plan U-3). Times are
-- timestamptz and the server times default to transaction_timestamp() (DB-TIM-001..002). Every foreign key is ON
-- DELETE RESTRICT (DB-FK-002, DB-XFN-003, SPEC-100 §11, plan U-6). No column beyond §42 / §43 is added: the Email
-- Worker's claim and lease belong to app.email_delivery_jobs (SPEC-120 §30, §38). No rows are created here, and no
-- trigger, function or existing object changes.

-- SPEC-100 §42 notification_requests. DB-XFN-001: one row per Business Cause (uq_..._business_cause_key, the UUIDv5
-- of SPEC-120 §8.2); a retry updates that row and never re-runs the source Order / Reservation. §42 CHECK: a source
-- Order or Reservation exists. render_context holds the non-secret snapshot only (EML-DB-002..003).
CREATE TABLE app.notification_requests (
 id bigint GENERATED ALWAYS AS IDENTITY,
 business_cause_key uuid NOT NULL,
 notification_type text NOT NULL,
 recipient_profile_id bigint NOT NULL,
 source_order_id bigint,
 source_reservation_id bigint,
 state text NOT NULL,
 render_context jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 sent_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 CONSTRAINT pk_notification_requests PRIMARY KEY (id),
 CONSTRAINT uq_notification_requests_business_cause_key UNIQUE (business_cause_key),
 CONSTRAINT fk_notification_requests_recipient_profile FOREIGN KEY (recipient_profile_id) REFERENCES app.business_profiles(id) ON DELETE RESTRICT,
 CONSTRAINT fk_notification_requests_source_order FOREIGN KEY (source_order_id) REFERENCES app.orders(id) ON DELETE RESTRICT,
 CONSTRAINT fk_notification_requests_source_reservation FOREIGN KEY (source_reservation_id) REFERENCES app.karaoke_reservations(id) ON DELETE RESTRICT,
 CONSTRAINT ck_notification_requests_state CHECK (state IN ('PENDING','SENT','FAILED_RETRYABLE','CANCELED')),
 CONSTRAINT ck_notification_requests_source CHECK (source_order_id IS NOT NULL OR source_reservation_id IS NOT NULL)
);

-- SPEC-100 §43 consistency_review_cases. DB-XFN-002: one Case per incident (uq_..._dedupe_key, generated
-- deterministically by the service; SPEC-150 REL-REC-007, REL-REC-016). DB-XFN-003: the ten target foreign keys keep
-- the history a Case points at, resolved or not. DB-XFN-004 / UCR-100-004: auth_subject has no foreign key (neon_auth
-- is another System of Record, §14.1) and no index, and is set exactly for AUTH_PROFILE_RELATION_INCONSISTENT. No
-- Case state is added: resolved_at IS NULL is the unresolved predicate (REL-REC-009).
CREATE TABLE app.consistency_review_cases (
 id bigint GENERATED ALWAYS AS IDENTITY,
 public_ref uuid NOT NULL DEFAULT gen_random_uuid(),
 dedupe_key text NOT NULL,
 reason_code text NOT NULL,
 order_id bigint,
 checkout_attempt_id bigint,
 payment_binding_id bigint,
 refund_record_id bigint,
 karaoke_slot_id bigint,
 karaoke_hold_id bigint,
 karaoke_reservation_id bigint,
 entry_ticket_id bigint,
 karaoke_ticket_id bigint,
 goods_order_item_id bigint,
 auth_subject uuid,
 details jsonb NOT NULL DEFAULT '{}'::jsonb,
 opened_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 resolved_at timestamptz,
 resolution_note text,
 CONSTRAINT pk_consistency_review_cases PRIMARY KEY (id),
 CONSTRAINT uq_consistency_review_cases_public_ref UNIQUE (public_ref),
 CONSTRAINT uq_consistency_review_cases_dedupe_key UNIQUE (dedupe_key),
 CONSTRAINT fk_consistency_review_cases_order FOREIGN KEY (order_id) REFERENCES app.orders(id) ON DELETE RESTRICT,
 CONSTRAINT fk_consistency_review_cases_checkout_attempt FOREIGN KEY (checkout_attempt_id) REFERENCES app.checkout_attempts(id) ON DELETE RESTRICT,
 CONSTRAINT fk_consistency_review_cases_payment_binding FOREIGN KEY (payment_binding_id) REFERENCES app.payment_bindings(id) ON DELETE RESTRICT,
 CONSTRAINT fk_consistency_review_cases_refund_record FOREIGN KEY (refund_record_id) REFERENCES app.refund_records(id) ON DELETE RESTRICT,
 CONSTRAINT fk_consistency_review_cases_karaoke_slot FOREIGN KEY (karaoke_slot_id) REFERENCES app.karaoke_slots(id) ON DELETE RESTRICT,
 CONSTRAINT fk_consistency_review_cases_karaoke_hold FOREIGN KEY (karaoke_hold_id) REFERENCES app.karaoke_holds(id) ON DELETE RESTRICT,
 CONSTRAINT fk_consistency_review_cases_karaoke_reservation FOREIGN KEY (karaoke_reservation_id) REFERENCES app.karaoke_reservations(id) ON DELETE RESTRICT,
 CONSTRAINT fk_consistency_review_cases_entry_ticket FOREIGN KEY (entry_ticket_id) REFERENCES app.entry_tickets(id) ON DELETE RESTRICT,
 CONSTRAINT fk_consistency_review_cases_karaoke_ticket FOREIGN KEY (karaoke_ticket_id) REFERENCES app.karaoke_tickets(id) ON DELETE RESTRICT,
 CONSTRAINT fk_consistency_review_cases_goods_order_item FOREIGN KEY (goods_order_item_id) REFERENCES app.goods_order_items(order_item_id) ON DELETE RESTRICT,
 CONSTRAINT ck_consistency_review_cases_target CHECK (
   order_id IS NOT NULL OR checkout_attempt_id IS NOT NULL OR payment_binding_id IS NOT NULL
   OR refund_record_id IS NOT NULL OR karaoke_slot_id IS NOT NULL OR karaoke_hold_id IS NOT NULL
   OR karaoke_reservation_id IS NOT NULL OR entry_ticket_id IS NOT NULL OR karaoke_ticket_id IS NOT NULL
   OR goods_order_item_id IS NOT NULL OR auth_subject IS NOT NULL
 ),
 CONSTRAINT ck_consistency_review_cases_auth_subject CHECK ((auth_subject IS NOT NULL) = (reason_code = 'AUTH_PROFILE_RELATION_INCONSISTENT'))
);

-- SPEC-100 §45.6: the Notification Requests the Email Worker still has to process, oldest first (SPEC-120 §30).
CREATE INDEX ix_notification_requests_pending ON app.notification_requests(created_at)
  WHERE state IN ('PENDING','FAILED_RETRYABLE');
-- SPEC-100 §43 / §45.6, REL-REC-009: the unresolved Cases, oldest first (SPEC-160 OBS-ALT-023..024 aging).
CREATE INDEX ix_consistency_review_cases_unresolved ON app.consistency_review_cases(opened_at)
  WHERE resolved_at IS NULL;

-- SEC-DB-001 / SEC-DB-003 / SPEC-140 §39 / SPEC-180 §22.2-22.4 / SPEC-100 §53; DB-FK-004 / SPEC-100 §12: no runtime
-- role may remove rows. No mounted Operation reads or writes these tables yet (purchase confirmation, the Email
-- Worker and the Recovery API come with later PRs), so no role gets a grant here (plan U-7). The PR that mounts an
-- Operation adds what it needs; identity sequences need no grant.
REVOKE ALL ON app.notification_requests, app.consistency_review_cases
  FROM PUBLIC, app_runtime, app_api_runtime, app_email_runtime, app_reconciliation_runtime;
