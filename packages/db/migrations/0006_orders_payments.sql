-- PR-L1-1a: the Order, Order Item, Entry Sales Allocation and payment-side tables (SPEC-100 §16-§18, §20-§23,
-- §45.1-§45.3, §45.7). Constraints and indexes carry explicit names (DB-ARC-007); the partial unique and partial
-- operational indexes are SQL-only DDL (SPEC-100 §57, DB-MIG-002). Money is bigint and currency is checked
-- (SPEC-100 §9); states are text with a named allowlist CHECK and no default, so the repository always sets them
-- (SPEC-100 §10, DB-STA-001..002). Times are timestamptz; created_at / updated_at default to
-- transaction_timestamp() and updated_at is maintained by the repository, not by a trigger (DB-TIM-001..003).
-- Every foreign key is ON DELETE RESTRICT (DB-FK-002, SPEC-100 §11). No rows are created here, and no trigger,
-- function or existing object changes. The state names are those of SPEC-030 (Order, Allocation) and SPEC-070
-- §17 / §37 (Webhook Receipt, Refund); creation_result is a processing result, not a Domain State (SPEC-100 §20).

-- SPEC-100 §16 orders. DB-ORD-001: customer, purpose, currency and total are fixed after creation (repository).
-- The three composite UNIQUE keys are the targets of the Order Item, Karaoke Hold / Reservation and Goods foreign
-- keys. The confirmed_at CHECK is both directions of §16 (CONFIRMED -> set, otherwise NULL); terminal_at is
-- required in the three terminal failure states and is not constrained otherwise (REVIEW_REQUIRED has none).
CREATE TABLE app.orders (
 id bigint GENERATED ALWAYS AS IDENTITY,
 public_ref uuid NOT NULL DEFAULT gen_random_uuid(),
 purchase_cause_key uuid NOT NULL,
 customer_profile_id bigint NOT NULL,
 purpose text NOT NULL,
 state text NOT NULL,
 currency text NOT NULL,
 total_amount bigint NOT NULL,
 confirmed_at timestamptz,
 terminal_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 CONSTRAINT pk_orders PRIMARY KEY (id),
 CONSTRAINT uq_orders_public_ref UNIQUE (public_ref),
 CONSTRAINT uq_orders_purchase_cause_key UNIQUE (purchase_cause_key),
 CONSTRAINT uq_orders_id_purpose UNIQUE (id, purpose),
 CONSTRAINT uq_orders_id_purpose_currency UNIQUE (id, purpose, currency),
 CONSTRAINT uq_orders_id_customer_profile_id UNIQUE (id, customer_profile_id),
 CONSTRAINT fk_orders_customer_profile FOREIGN KEY (customer_profile_id) REFERENCES app.business_profiles(id) ON DELETE RESTRICT,
 CONSTRAINT ck_orders_purpose CHECK (purpose IN ('ENTRY_TICKET_PURCHASE','KARAOKE_PURCHASE','GOODS_PURCHASE','ENTRY_GOODS_PURCHASE')),
 CONSTRAINT ck_orders_state CHECK (state IN ('PREPARED','AWAITING_PAYMENT','CONFIRMED','PAYMENT_FAILED','CANCELED','EXPIRED','REVIEW_REQUIRED')),
 CONSTRAINT ck_orders_currency CHECK (currency = upper(currency) AND currency ~ '^[A-Z]{3}$'),
 CONSTRAINT ck_orders_total_amount CHECK (total_amount >= 0),
 CONSTRAINT ck_orders_confirmed_at CHECK ((state = 'CONFIRMED') = (confirmed_at IS NOT NULL)),
 CONSTRAINT ck_orders_terminal_at CHECK (state NOT IN ('PAYMENT_FAILED','CANCELED','EXPIRED') OR terminal_at IS NOT NULL)
);

-- SPEC-100 §17 order_items. DB-ORD-002..004 / UCR-100-003: one Order has one Purpose; each item repeats it, and the
-- composite foreign key keeps purpose and currency equal to the Order's. ck_order_items_source is the Purpose /
-- purchase source exclusivity (Karaoke: one slot, quantity 1; the composite Purpose: an Entry or a Goods source,
-- never both). Order-wide composition and totals are transaction preconditions, not row constraints (DB-ORD-003).
-- line_total_amount is generated (SPEC-100 §9, DB-MNY-001). The UNIQUE keys are composite foreign key targets.
CREATE TABLE app.order_items (
 id bigint GENERATED ALWAYS AS IDENTITY,
 order_id bigint NOT NULL,
 purpose text NOT NULL,
 line_no integer NOT NULL,
 quantity integer NOT NULL,
 unit_amount bigint NOT NULL,
 currency text NOT NULL,
 line_total_amount bigint GENERATED ALWAYS AS (unit_amount * quantity::bigint) STORED,
 item_name_snapshot text NOT NULL,
 entry_offering_id bigint,
 karaoke_slot_id bigint,
 goods_id bigint,
 created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 CONSTRAINT pk_order_items PRIMARY KEY (id),
 CONSTRAINT uq_order_items_order_id_line_no UNIQUE (order_id, line_no),
 CONSTRAINT uq_order_items_id_order_id UNIQUE (id, order_id),
 CONSTRAINT uq_order_items_id_purpose UNIQUE (id, purpose),
 CONSTRAINT uq_order_items_id_order_id_purpose UNIQUE (id, order_id, purpose),
 CONSTRAINT uq_order_items_id_order_id_purpose_karaoke_slot_id UNIQUE (id, order_id, purpose, karaoke_slot_id),
 CONSTRAINT uq_order_items_id_entry_offering_id UNIQUE (id, entry_offering_id),
 CONSTRAINT uq_order_items_id_goods_id UNIQUE (id, goods_id),
 CONSTRAINT fk_order_items_order FOREIGN KEY (order_id, purpose, currency) REFERENCES app.orders(id, purpose, currency) ON DELETE RESTRICT,
 CONSTRAINT fk_order_items_entry_offering FOREIGN KEY (entry_offering_id) REFERENCES app.entry_ticket_offerings(id) ON DELETE RESTRICT,
 CONSTRAINT fk_order_items_karaoke_slot FOREIGN KEY (karaoke_slot_id) REFERENCES app.karaoke_slots(id) ON DELETE RESTRICT,
 CONSTRAINT fk_order_items_goods FOREIGN KEY (goods_id) REFERENCES app.goods(id) ON DELETE RESTRICT,
 CONSTRAINT ck_order_items_line_no CHECK (line_no > 0),
 CONSTRAINT ck_order_items_quantity CHECK (quantity > 0),
 CONSTRAINT ck_order_items_unit_amount CHECK (unit_amount >= 0),
 CONSTRAINT ck_order_items_currency CHECK (currency = upper(currency) AND currency ~ '^[A-Z]{3}$'),
 CONSTRAINT ck_order_items_source CHECK (
   (purpose = 'ENTRY_TICKET_PURCHASE' AND entry_offering_id IS NOT NULL AND karaoke_slot_id IS NULL AND goods_id IS NULL)
   OR (purpose = 'KARAOKE_PURCHASE' AND entry_offering_id IS NULL AND karaoke_slot_id IS NOT NULL AND goods_id IS NULL AND quantity = 1)
   OR (purpose = 'GOODS_PURCHASE' AND entry_offering_id IS NULL AND karaoke_slot_id IS NULL AND goods_id IS NOT NULL)
   OR (purpose = 'ENTRY_GOODS_PURCHASE' AND karaoke_slot_id IS NULL
       AND ((entry_offering_id IS NOT NULL AND goods_id IS NULL) OR (entry_offering_id IS NULL AND goods_id IS NOT NULL)))
 )
);

-- SPEC-100 §18 entry_sales_allocations. One Allocation per Entry Order Item; the two composite foreign keys keep its
-- Order, Purpose and Offering equal to the item's. DI-030-004 / SPEC-030 Allocation: HELD, COMMITTED and RELEASED
-- with their timestamps; COMMITTED and RELEASED are terminal (DB-ENT-001, conditional update in the repository).
-- The offering counters change in the same transaction (DB-ENT-002); no trigger does it.
CREATE TABLE app.entry_sales_allocations (
 id bigint GENERATED ALWAYS AS IDENTITY,
 order_item_id bigint NOT NULL,
 order_id bigint NOT NULL,
 purpose text NOT NULL,
 offering_id bigint NOT NULL,
 quantity integer NOT NULL,
 state text NOT NULL,
 held_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 committed_at timestamptz,
 released_at timestamptz,
 CONSTRAINT pk_entry_sales_allocations PRIMARY KEY (id),
 CONSTRAINT uq_entry_sales_allocations_order_item_id UNIQUE (order_item_id),
 CONSTRAINT fk_entry_sales_allocations_order_item FOREIGN KEY (order_item_id, order_id, purpose) REFERENCES app.order_items(id, order_id, purpose) ON DELETE RESTRICT,
 CONSTRAINT fk_entry_sales_allocations_offering FOREIGN KEY (order_item_id, offering_id) REFERENCES app.order_items(id, entry_offering_id) ON DELETE RESTRICT,
 CONSTRAINT ck_entry_sales_allocations_purpose CHECK (purpose IN ('ENTRY_TICKET_PURCHASE','ENTRY_GOODS_PURCHASE')),
 CONSTRAINT ck_entry_sales_allocations_quantity CHECK (quantity > 0),
 CONSTRAINT ck_entry_sales_allocations_state CHECK (state IN ('HELD','COMMITTED','RELEASED')),
 CONSTRAINT ck_entry_sales_allocations_state_times CHECK (
   (state = 'HELD' AND committed_at IS NULL AND released_at IS NULL)
   OR (state = 'COMMITTED' AND committed_at IS NOT NULL AND released_at IS NULL)
   OR (state = 'RELEASED' AND released_at IS NOT NULL AND committed_at IS NULL)
 )
);

-- SPEC-100 §20 checkout_attempts. DB-PAY-001 / PAY-CHK-008: a retry reuses the same attempt and Stripe idempotency
-- key. uq_checkout_attempts_id_order_id is the target of the Payment Binding composite foreign key (§21).
CREATE TABLE app.checkout_attempts (
 id bigint GENERATED ALWAYS AS IDENTITY,
 public_ref uuid NOT NULL DEFAULT gen_random_uuid(),
 order_id bigint NOT NULL,
 attempt_no integer NOT NULL,
 stripe_idempotency_key text NOT NULL,
 creation_result text NOT NULL,
 provider_request_started_at timestamptz,
 provider_response_at timestamptz,
 last_error_code text,
 created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 CONSTRAINT pk_checkout_attempts PRIMARY KEY (id),
 CONSTRAINT uq_checkout_attempts_public_ref UNIQUE (public_ref),
 CONSTRAINT uq_checkout_attempts_stripe_idempotency_key UNIQUE (stripe_idempotency_key),
 CONSTRAINT uq_checkout_attempts_order_id_attempt_no UNIQUE (order_id, attempt_no),
 CONSTRAINT uq_checkout_attempts_id_order_id UNIQUE (id, order_id),
 CONSTRAINT fk_checkout_attempts_order FOREIGN KEY (order_id) REFERENCES app.orders(id) ON DELETE RESTRICT,
 CONSTRAINT ck_checkout_attempts_attempt_no CHECK (attempt_no > 0),
 CONSTRAINT ck_checkout_attempts_creation_result CHECK (creation_result IN ('PENDING','SUCCEEDED','FAILED','UNKNOWN'))
);

-- SPEC-100 §21 payment_bindings. DB-PAY-002: a Stripe Checkout Session, PaymentIntent or Charge binds to one Order
-- only. The composite foreign key keeps the attempt's Order equal to the binding's. PAY-CHK-* / §67 item 24: the
-- payment deadline is fixed at Session creation + 30 minutes as a generated column. timestamptz + interval is
-- STABLE (it depends on TimeZone) and PostgreSQL refuses it in a generated column, so the sum is taken in UTC, which
-- has no daylight saving time: the value equals checkout_session_created_at + 30 minutes for every input
-- (UCR-100-006). is_active and deactivated_at always agree.
CREATE TABLE app.payment_bindings (
 id bigint GENERATED ALWAYS AS IDENTITY,
 order_id bigint NOT NULL,
 checkout_attempt_id bigint NOT NULL,
 stripe_checkout_session_id text NOT NULL,
 stripe_payment_intent_id text,
 stripe_charge_id text,
 checkout_session_created_at timestamptz NOT NULL,
 payment_deadline_at timestamptz GENERATED ALWAYS AS (((checkout_session_created_at AT TIME ZONE 'UTC') + interval '30 minutes') AT TIME ZONE 'UTC') STORED,
 payment_completed_at timestamptz,
 amount_total bigint NOT NULL,
 currency text NOT NULL,
 is_active boolean NOT NULL DEFAULT true,
 bound_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 deactivated_at timestamptz,
 stripe_receipt_url text,
 CONSTRAINT pk_payment_bindings PRIMARY KEY (id),
 CONSTRAINT uq_payment_bindings_checkout_attempt_id UNIQUE (checkout_attempt_id),
 CONSTRAINT uq_payment_bindings_stripe_checkout_session_id UNIQUE (stripe_checkout_session_id),
 CONSTRAINT uq_payment_bindings_stripe_payment_intent_id UNIQUE (stripe_payment_intent_id),
 CONSTRAINT uq_payment_bindings_stripe_charge_id UNIQUE (stripe_charge_id),
 CONSTRAINT fk_payment_bindings_order FOREIGN KEY (order_id) REFERENCES app.orders(id) ON DELETE RESTRICT,
 CONSTRAINT fk_payment_bindings_checkout_attempt FOREIGN KEY (checkout_attempt_id, order_id) REFERENCES app.checkout_attempts(id, order_id) ON DELETE RESTRICT,
 CONSTRAINT ck_payment_bindings_amount_total CHECK (amount_total >= 0),
 CONSTRAINT ck_payment_bindings_currency CHECK (currency = upper(currency) AND currency ~ '^[A-Z]{3}$'),
 CONSTRAINT ck_payment_bindings_active CHECK (is_active = (deactivated_at IS NULL))
);

-- SPEC-100 §22 webhook_receipts. PAY-WHK-007 / SEC-PAY-008 / DB-PAY-005: one receipt per Stripe Event ID, so a
-- redelivered Event never repeats its effect. Only a minimal canonical snapshot and the payload digest are stored;
-- the raw body is not (SPEC-100 §22 payload retention).
CREATE TABLE app.webhook_receipts (
 id bigint GENERATED ALWAYS AS IDENTITY,
 stripe_event_id text NOT NULL,
 event_type text NOT NULL,
 stripe_object_id text,
 stripe_account_id text,
 livemode boolean NOT NULL,
 processing_state text NOT NULL,
 payload_sha256 bytea NOT NULL,
 canonical_snapshot jsonb NOT NULL,
 received_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 processed_at timestamptz,
 last_error_code text,
 updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 CONSTRAINT pk_webhook_receipts PRIMARY KEY (id),
 CONSTRAINT uq_webhook_receipts_stripe_event_id UNIQUE (stripe_event_id),
 CONSTRAINT ck_webhook_receipts_processing_state CHECK (processing_state IN ('RECEIVED','PROCESSED','IGNORED','FAILED_RETRYABLE','REVIEW_REQUIRED')),
 CONSTRAINT ck_webhook_receipts_payload_sha256 CHECK (octet_length(payload_sha256) = 32)
);

-- SPEC-100 §23 refund_records. PAY-RFD-* / PAY-IDM-008..009: one record per refund Business Cause and per Stripe
-- idempotency key. Amount and currency are derived server-side (DB-PAY-006); the Refund state is separate from the
-- Domain cancellation (DB-PAY-007).
CREATE TABLE app.refund_records (
 id bigint GENERATED ALWAYS AS IDENTITY,
 order_id bigint NOT NULL,
 business_cause_key uuid NOT NULL,
 stripe_idempotency_key text NOT NULL,
 stripe_refund_id text,
 state text NOT NULL,
 requested_amount bigint NOT NULL,
 currency text NOT NULL,
 is_full_refund boolean NOT NULL,
 requested_by_profile_id bigint NOT NULL,
 requested_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 provider_updated_at timestamptz,
 succeeded_at timestamptz,
 failed_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 CONSTRAINT pk_refund_records PRIMARY KEY (id),
 CONSTRAINT uq_refund_records_business_cause_key UNIQUE (business_cause_key),
 CONSTRAINT uq_refund_records_stripe_idempotency_key UNIQUE (stripe_idempotency_key),
 CONSTRAINT uq_refund_records_stripe_refund_id UNIQUE (stripe_refund_id),
 CONSTRAINT fk_refund_records_order FOREIGN KEY (order_id) REFERENCES app.orders(id) ON DELETE RESTRICT,
 CONSTRAINT fk_refund_records_requested_by_profile FOREIGN KEY (requested_by_profile_id) REFERENCES app.business_profiles(id) ON DELETE RESTRICT,
 CONSTRAINT ck_refund_records_state CHECK (state IN ('REQUESTED','PENDING','SUCCEEDED','FAILED','REVIEW_REQUIRED')),
 CONSTRAINT ck_refund_records_requested_amount CHECK (requested_amount > 0),
 CONSTRAINT ck_refund_records_currency CHECK (currency = upper(currency) AND currency ~ '^[A-Z]{3}$')
);

-- SPEC-100 §45.1 / §45.7: Customer -> Order and the two admin Order searches.
CREATE INDEX ix_orders_customer_created ON app.orders(customer_profile_id, created_at DESC);
CREATE INDEX ix_orders_admin_state_created ON app.orders(state, created_at DESC);
CREATE INDEX ix_orders_admin_purpose_created ON app.orders(purpose, created_at DESC);
-- SPEC-100 §45.3: Allocations by Offering and state.
CREATE INDEX ix_entry_allocations_offering_state ON app.entry_sales_allocations(offering_id, state);
-- SPEC-100 §45.2. ix_checkout_attempts_order_attempt is named by §45.2 although uq_checkout_attempts_order_id_attempt_no
-- covers the same columns (a btree is scanned in either direction); it is kept as §45.2 lists it (plan U-3).
CREATE INDEX ix_checkout_attempts_order_attempt ON app.checkout_attempts(order_id, attempt_no DESC);
CREATE INDEX ix_payment_bindings_order_bound ON app.payment_bindings(order_id, bound_at DESC);
-- DB-PAY-003 / PAY-CHK-* / §67 item 13: one active Checkout per Order.
CREATE UNIQUE INDEX ux_payment_bindings_order_active ON app.payment_bindings(order_id) WHERE is_active;
-- SPEC-100 §22: receipts waiting for a retry or a review.
CREATE INDEX ix_webhook_receipts_retry ON app.webhook_receipts(received_at)
  WHERE processing_state IN ('FAILED_RETRYABLE','REVIEW_REQUIRED');
-- SPEC-100 §23 / §67 item 15: at most one live or succeeded full refund per Order. A FAILED record leaves room for a
-- new Business Cause; partial refunds are outside this index.
CREATE UNIQUE INDEX ux_refund_records_order_live_full ON app.refund_records(order_id)
  WHERE is_full_refund AND state IN ('REQUESTED','PENDING','SUCCEEDED','REVIEW_REQUIRED');

-- SEC-DB-001 / SEC-DB-003 / SPEC-140 §39 / SPEC-180 §22.2-22.4 / SPEC-100 §53; DB-FK-004 / SPEC-100 §12: no runtime
-- role may remove rows. No mounted Operation reads or writes these tables yet (purchase start is PR-L1-2, the Stripe
-- Webhook is PR-L1-3, refunds come later), so no role gets a grant here (plan U-4). The PR that mounts an Operation
-- adds what it needs; identity sequences need no grant.
REVOKE ALL ON app.orders, app.order_items, app.entry_sales_allocations, app.checkout_attempts,
  app.payment_bindings, app.webhook_receipts, app.refund_records
  FROM PUBLIC, app_runtime, app_api_runtime, app_email_runtime, app_reconciliation_runtime;
