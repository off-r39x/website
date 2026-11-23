-- PR-GK-2: the Karaoke Hold, Reservation, Karaoke Ticket and Karaoke Check-in tables (SPEC-100 §30, §33, §34, §37,
-- §45.1, §45.4, §45.5). Constraints and indexes carry explicit names (DB-ARC-007); the two partial indexes and the
-- composite constraint names are SQL-only DDL (SPEC-100 §57, DB-MIG-002). States are text with a named allowlist
-- CHECK and no default, so the repository always sets them (SPEC-100 §10, DB-STA-001..002). Times are timestamptz;
-- created_at / updated_at and the other server times default to transaction_timestamp(), and updated_at is
-- maintained by the repository, not by a trigger (DB-TIM-001..003, plan U-3). Every foreign key is ON DELETE
-- RESTRICT (DB-FK-002, SPEC-100 §11). No rows are created here, and no trigger, function or existing object changes.
-- The Hold acquire, Business Confirmation, cancellation and check-in transactions (SPEC-100 §31, §35-§37) are not
-- part of this migration; the cross-table preconditions they check (Ticket expires_at = usage_end_snapshot, the
-- check-in window, the Checkout activation condition of §32) are not row constraints.

-- SPEC-100 §30 karaoke_holds. KRK-HLD-* / BR-KRK-004..007. The Hold repeats its Karaoke Order Item's Order, Purpose
-- and Slot (fk_karaoke_holds_order_item -> uq_order_items_id_order_id_purpose_karaoke_slot_id) and its Order's
-- Customer (fk_karaoke_holds_order -> uq_orders_id_customer_profile_id). uq_karaoke_holds_order_item_id: a Checkout
-- retry of the same item never creates a new Hold. uq_karaoke_holds_reservation_target is the target of the
-- Reservation composite foreign key (§33; named by its purpose because the column list exceeds 63 bytes, plan U-1).
-- DB-KRK-006 / §67 item 23: the expiry is fixed at acquisition + 45 minutes as a generated column. timestamptz +
-- interval is STABLE (it depends on TimeZone) and PostgreSQL refuses it in a generated column, so the sum is taken
-- in UTC, which has no daylight saving time: the value equals hold_acquired_at + 45 minutes for every input
-- (UCR-100-006, SPEC-100 §57). ck_karaoke_holds_state_times is the four lines of §30 as written (plan U-2).
CREATE TABLE app.karaoke_holds (
 id bigint GENERATED ALWAYS AS IDENTITY,
 public_ref uuid NOT NULL DEFAULT gen_random_uuid(),
 order_id bigint NOT NULL,
 order_item_id bigint NOT NULL,
 order_purpose text NOT NULL DEFAULT 'KARAOKE_PURCHASE',
 customer_profile_id bigint NOT NULL,
 slot_id bigint NOT NULL,
 state text NOT NULL,
 hold_acquired_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 hold_expires_at timestamptz GENERATED ALWAYS AS (((hold_acquired_at AT TIME ZONE 'UTC') + interval '45 minutes') AT TIME ZONE 'UTC') STORED,
 committed_at timestamptz,
 released_at timestamptz,
 expired_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 CONSTRAINT pk_karaoke_holds PRIMARY KEY (id),
 CONSTRAINT uq_karaoke_holds_public_ref UNIQUE (public_ref),
 CONSTRAINT uq_karaoke_holds_order_item_id UNIQUE (order_item_id),
 CONSTRAINT uq_karaoke_holds_reservation_target UNIQUE (id, order_id, order_item_id, customer_profile_id, slot_id),
 CONSTRAINT fk_karaoke_holds_order_item FOREIGN KEY (order_item_id, order_id, order_purpose, slot_id) REFERENCES app.order_items(id, order_id, purpose, karaoke_slot_id) ON DELETE RESTRICT,
 CONSTRAINT fk_karaoke_holds_order FOREIGN KEY (order_id, customer_profile_id) REFERENCES app.orders(id, customer_profile_id) ON DELETE RESTRICT,
 CONSTRAINT ck_karaoke_holds_order_purpose CHECK (order_purpose = 'KARAOKE_PURCHASE'),
 CONSTRAINT ck_karaoke_holds_state CHECK (state IN ('ACTIVE','COMMITTED','RELEASED','EXPIRED')),
 CONSTRAINT ck_karaoke_holds_state_times CHECK (
   (state = 'ACTIVE' AND committed_at IS NULL AND released_at IS NULL AND expired_at IS NULL)
   OR (state = 'COMMITTED' AND committed_at IS NOT NULL)
   OR (state = 'RELEASED' AND released_at IS NOT NULL)
   OR (state = 'EXPIRED' AND expired_at IS NOT NULL)
 )
);

-- SPEC-100 §33 karaoke_reservations. DB-KRK-011 / §67 item 26: at most one Reservation per Karaoke Order Item, Slot
-- and Hold; the UNIQUEs have no predicate, so a CANCELED Reservation keeps its Slot, Hold and item (DB-KRK-013).
-- §67 item 28: fk_karaoke_reservations_hold keeps the Reservation's Order, item, Customer and Slot equal to its
-- Hold's. DB-KRK-012: CONFIRMED and CANCELED only, never USED. uq_karaoke_reservations_id_customer_profile_id is
-- the target of the Karaoke Ticket composite foreign key (§34).
CREATE TABLE app.karaoke_reservations (
 id bigint GENERATED ALWAYS AS IDENTITY,
 public_ref uuid NOT NULL DEFAULT gen_random_uuid(),
 order_id bigint NOT NULL,
 order_item_id bigint NOT NULL,
 hold_id bigint NOT NULL,
 customer_profile_id bigint NOT NULL,
 slot_id bigint NOT NULL,
 state text NOT NULL,
 usage_start_snapshot timestamptz NOT NULL,
 usage_end_snapshot timestamptz NOT NULL,
 confirmed_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 canceled_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 CONSTRAINT pk_karaoke_reservations PRIMARY KEY (id),
 CONSTRAINT uq_karaoke_reservations_public_ref UNIQUE (public_ref),
 CONSTRAINT uq_karaoke_reservations_order_item_id UNIQUE (order_item_id),
 CONSTRAINT uq_karaoke_reservations_slot_id UNIQUE (slot_id),
 CONSTRAINT uq_karaoke_reservations_hold_id UNIQUE (hold_id),
 CONSTRAINT uq_karaoke_reservations_id_customer_profile_id UNIQUE (id, customer_profile_id),
 CONSTRAINT fk_karaoke_reservations_hold FOREIGN KEY (hold_id, order_id, order_item_id, customer_profile_id, slot_id) REFERENCES app.karaoke_holds(id, order_id, order_item_id, customer_profile_id, slot_id) ON DELETE RESTRICT,
 CONSTRAINT ck_karaoke_reservations_state CHECK (state IN ('CONFIRMED','CANCELED')),
 CONSTRAINT ck_karaoke_reservations_usage_snapshot CHECK (usage_start_snapshot < usage_end_snapshot),
 CONSTRAINT ck_karaoke_reservations_canceled_at CHECK ((state = 'CANCELED') = (canceled_at IS NOT NULL))
);

-- SPEC-100 §34 karaoke_tickets. DB-KRK-014 / §67 item 27: one Karaoke Ticket per Reservation. DB-KRK-015: the
-- owner is the Reservation's Customer (composite foreign key). expires_at equals the Reservation's
-- usage_end_snapshot; that cross-table equality is checked by the confirmation transaction, not here.
CREATE TABLE app.karaoke_tickets (
 id bigint GENERATED ALWAYS AS IDENTITY,
 public_ref uuid NOT NULL DEFAULT gen_random_uuid(),
 reservation_id bigint NOT NULL,
 owner_profile_id bigint NOT NULL,
 state text NOT NULL,
 expires_at timestamptz NOT NULL,
 issued_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 state_changed_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 CONSTRAINT pk_karaoke_tickets PRIMARY KEY (id),
 CONSTRAINT uq_karaoke_tickets_public_ref UNIQUE (public_ref),
 CONSTRAINT uq_karaoke_tickets_reservation_id UNIQUE (reservation_id),
 CONSTRAINT fk_karaoke_tickets_reservation FOREIGN KEY (reservation_id, owner_profile_id) REFERENCES app.karaoke_reservations(id, customer_profile_id) ON DELETE RESTRICT,
 CONSTRAINT ck_karaoke_tickets_state CHECK (state IN ('VALID','USED','CANCELED','EXPIRED'))
);

-- SPEC-100 §37 karaoke_checkins. §67 item 18 / INV-010-05: at most one Check-in per Karaoke Ticket. The check-in
-- window is a query predicate on the Reservation snapshot; no checkin_opens_at / checkin_closes_at is stored.
CREATE TABLE app.karaoke_checkins (
 id bigint GENERATED ALWAYS AS IDENTITY,
 karaoke_ticket_id bigint NOT NULL,
 staff_profile_id bigint NOT NULL,
 staff_role_assignment_id bigint NOT NULL,
 checked_in_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 CONSTRAINT pk_karaoke_checkins PRIMARY KEY (id),
 CONSTRAINT uq_karaoke_checkins_karaoke_ticket_id UNIQUE (karaoke_ticket_id),
 CONSTRAINT fk_karaoke_checkins_karaoke_ticket FOREIGN KEY (karaoke_ticket_id) REFERENCES app.karaoke_tickets(id) ON DELETE RESTRICT,
 CONSTRAINT fk_karaoke_checkins_staff_profile FOREIGN KEY (staff_profile_id) REFERENCES app.business_profiles(id) ON DELETE RESTRICT,
 CONSTRAINT fk_karaoke_checkins_staff_role_assignment FOREIGN KEY (staff_role_assignment_id) REFERENCES app.role_assignments(id) ON DELETE RESTRICT
);

-- DB-KRK-007 / KRK-HLD-* / §67 item 22: at most one ACTIVE Hold per Slot. Holds in the other three states are not
-- limited. The Slot row lock and conditional update of the acquire transaction (§31) come first; this index is the
-- last defence.
CREATE UNIQUE INDEX ux_karaoke_holds_slot_active ON app.karaoke_holds(slot_id) WHERE state = 'ACTIVE';
-- SPEC-100 §45.4: active Holds by Customer for the purchase limit.
CREATE INDEX ix_karaoke_holds_customer_active ON app.karaoke_holds(customer_profile_id, slot_id) WHERE state = 'ACTIVE';
-- SPEC-100 §45.1: Customer -> Karaoke Reservation; §45.4: the admin Reservation search.
CREATE INDEX ix_karaoke_reservations_customer_time ON app.karaoke_reservations(customer_profile_id, usage_start_snapshot DESC);
CREATE INDEX ix_karaoke_reservations_state_time ON app.karaoke_reservations(state, usage_start_snapshot DESC);

-- SEC-DB-001 / SEC-DB-003 / SPEC-140 §39 / SPEC-180 §22.2-22.4 / SPEC-100 §53; DB-FK-004 / SPEC-100 §12: no runtime
-- role may remove rows. No mounted Operation reads or writes these tables: Karaoke purchase, confirmation,
-- cancellation, check-in and the owner reads are not released (UCR-RELSCOPE-001), so no role gets a grant here
-- (plan U-4). The PR that mounts an Operation adds what it needs; identity sequences need no grant.
REVOKE ALL ON app.karaoke_holds, app.karaoke_reservations, app.karaoke_tickets, app.karaoke_checkins
  FROM PUBLIC, app_runtime, app_api_runtime, app_email_runtime, app_reconciliation_runtime;
