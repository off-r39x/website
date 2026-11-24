-- PR-L1-1b: the Entry Ticket, QR Token and Entry Check-in tables (SPEC-100 §24-§26, §45.1, §45.3, §45.5).
-- Constraints and indexes carry explicit names (DB-ARC-007); the two partial UNIQUE indexes and the composite
-- constraint names are SQL-only DDL (SPEC-100 §57, DB-MIG-002). States, purposes and the QR format version are
-- text with a named allowlist CHECK and no default, so the repository always sets them (SPEC-100 §10,
-- DB-STA-001..002, plan U-3). Times are timestamptz and the server times default to transaction_timestamp()
-- (DB-TIM-001..002). Every foreign key is ON DELETE RESTRICT, including those §24 and §26 leave unspecified
-- (DB-FK-002, SPEC-100 §11, plan U-2). No CHECK beyond §24-§26 is added (plan U-4). No rows are created here, and
-- no trigger, function or existing object changes. Ticket issuance (the ordinal <= quantity and N-Tickets checks of
-- DB-TQR-001), QR provisioning, lookup and rotation, and the check-in transaction of §26 (DB-TQR-005, DB-TQR-006)
-- are not part of this migration.

-- SPEC-100 §24 entry_tickets. DB-TQR-001 / INV-010-03 / §67 item 11: one Ticket per (Order Item, issuance
-- ordinal), so a retried issuance reuses the ordinal instead of adding a Ticket. fk_entry_tickets_order_item keeps
-- the Ticket's Order and Purpose equal to its item's (uq_order_items_id_order_id_purpose); fk_entry_tickets_order
-- keeps the owner equal to the Order's Customer (uq_orders_id_customer_profile_id, TQR-TKT-004);
-- fk_entry_tickets_entry_sales_allocation refuses a Ticket of an item without an Entry Allocation, such as the
-- Goods line of a composite Order. No Offering id is stored: it is resolved through the Allocation (§24).
CREATE TABLE app.entry_tickets (
 id bigint GENERATED ALWAYS AS IDENTITY,
 public_ref uuid NOT NULL DEFAULT gen_random_uuid(),
 order_id bigint NOT NULL,
 order_item_id bigint NOT NULL,
 order_purpose text NOT NULL,
 owner_profile_id bigint NOT NULL,
 issuance_ordinal integer NOT NULL,
 state text NOT NULL,
 valid_from timestamptz,
 valid_until timestamptz,
 issued_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 state_changed_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 CONSTRAINT pk_entry_tickets PRIMARY KEY (id),
 CONSTRAINT uq_entry_tickets_public_ref UNIQUE (public_ref),
 CONSTRAINT uq_entry_tickets_order_item_id_issuance_ordinal UNIQUE (order_item_id, issuance_ordinal),
 CONSTRAINT fk_entry_tickets_order_item FOREIGN KEY (order_item_id, order_id, order_purpose) REFERENCES app.order_items(id, order_id, purpose) ON DELETE RESTRICT,
 CONSTRAINT fk_entry_tickets_order FOREIGN KEY (order_id, owner_profile_id) REFERENCES app.orders(id, customer_profile_id) ON DELETE RESTRICT,
 CONSTRAINT fk_entry_tickets_entry_sales_allocation FOREIGN KEY (order_item_id) REFERENCES app.entry_sales_allocations(order_item_id) ON DELETE RESTRICT,
 CONSTRAINT ck_entry_tickets_order_purpose CHECK (order_purpose IN ('ENTRY_TICKET_PURCHASE','ENTRY_GOODS_PURCHASE')),
 CONSTRAINT ck_entry_tickets_issuance_ordinal CHECK (issuance_ordinal > 0),
 CONSTRAINT ck_entry_tickets_state CHECK (state IN ('VALID','USED','CANCELED','EXPIRED')),
 CONSTRAINT ck_entry_tickets_valid_period CHECK (valid_from IS NULL OR valid_until IS NULL OR valid_from < valid_until)
);

-- SPEC-100 §25 qr_tokens: a controlled polymorphic relation to exactly one Entry or Karaoke Ticket.
-- ck_qr_tokens_purpose_target keeps the Entry and Karaoke purposes apart (TQR-TOK-006, TQR-TOK-007, SPEC-080 §10).
-- DB-TQR-002 / §67 item 17: no plaintext column; the token exists only as the 32-byte HMAC-SHA-256 lookup digest
-- (SPEC-140 §54, unique for the §51 lookup) and the application-encrypted envelope (SPEC-140 §55, opaque here).
-- DB-TQR-003: a REVOKED Token keeps its Ticket correlation; ck_qr_tokens_revoked_at is the two lifecycle lines of §25.
CREATE TABLE app.qr_tokens (
 id bigint GENERATED ALWAYS AS IDENTITY,
 format_version text NOT NULL,
 purpose text NOT NULL,
 entry_ticket_id bigint,
 karaoke_ticket_id bigint,
 lifecycle_state text NOT NULL,
 lookup_digest bytea NOT NULL,
 protected_token_material bytea NOT NULL,
 protection_key_version integer NOT NULL,
 issued_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 revoked_at timestamptz,
 CONSTRAINT pk_qr_tokens PRIMARY KEY (id),
 CONSTRAINT uq_qr_tokens_lookup_digest UNIQUE (lookup_digest),
 CONSTRAINT fk_qr_tokens_entry_ticket FOREIGN KEY (entry_ticket_id) REFERENCES app.entry_tickets(id) ON DELETE RESTRICT,
 CONSTRAINT fk_qr_tokens_karaoke_ticket FOREIGN KEY (karaoke_ticket_id) REFERENCES app.karaoke_tickets(id) ON DELETE RESTRICT,
 CONSTRAINT ck_qr_tokens_format_version CHECK (format_version = 'r39x1'),
 CONSTRAINT ck_qr_tokens_purpose CHECK (purpose IN ('ENTRY','KARAOKE')),
 CONSTRAINT ck_qr_tokens_purpose_target CHECK (
   (purpose = 'ENTRY' AND entry_ticket_id IS NOT NULL AND karaoke_ticket_id IS NULL)
   OR (purpose = 'KARAOKE' AND entry_ticket_id IS NULL AND karaoke_ticket_id IS NOT NULL)
 ),
 CONSTRAINT ck_qr_tokens_lifecycle_state CHECK (lifecycle_state IN ('ACTIVE','REVOKED')),
 CONSTRAINT ck_qr_tokens_revoked_at CHECK ((lifecycle_state = 'REVOKED') = (revoked_at IS NOT NULL)),
 CONSTRAINT ck_qr_tokens_lookup_digest_length CHECK (octet_length(lookup_digest) = 32),
 CONSTRAINT ck_qr_tokens_protection_key_version CHECK (protection_key_version > 0)
);

-- SPEC-100 §26 entry_checkins: an immutable Business Event. INV-010-05 / §67 item 18: at most one Entry Check-in per
-- Ticket; the Ticket row lock and the conditional VALID -> USED update of the check-in transaction come first, and
-- uq_entry_checkins_entry_ticket_id is the secondary defence (§26 step 5). The same shape as karaoke_checkins (0007).
CREATE TABLE app.entry_checkins (
 id bigint GENERATED ALWAYS AS IDENTITY,
 entry_ticket_id bigint NOT NULL,
 staff_profile_id bigint NOT NULL,
 staff_role_assignment_id bigint NOT NULL,
 checked_in_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 CONSTRAINT pk_entry_checkins PRIMARY KEY (id),
 CONSTRAINT uq_entry_checkins_entry_ticket_id UNIQUE (entry_ticket_id),
 CONSTRAINT fk_entry_checkins_entry_ticket FOREIGN KEY (entry_ticket_id) REFERENCES app.entry_tickets(id) ON DELETE RESTRICT,
 CONSTRAINT fk_entry_checkins_staff_profile FOREIGN KEY (staff_profile_id) REFERENCES app.business_profiles(id) ON DELETE RESTRICT,
 CONSTRAINT fk_entry_checkins_staff_role_assignment FOREIGN KEY (staff_role_assignment_id) REFERENCES app.role_assignments(id) ON DELETE RESTRICT
);

-- SPEC-100 §45.1: Customer -> Entry Ticket (owner list, issued_at DESC). §45.3: no separate order_item_id index, the
-- UNIQUE (order_item_id, issuance_ordinal) prefix serves it.
CREATE INDEX ix_entry_tickets_owner_issued ON app.entry_tickets(owner_profile_id, issued_at DESC);
-- SPEC-100 §25 / §45.5, TQR-TOK-013 / TQR-TOK-016 / §67 item 16: at most one ACTIVE Token per Entry Ticket and per
-- Karaoke Ticket. REVOKED Tokens are not limited (rotation history, DB-TQR-003).
CREATE UNIQUE INDEX ux_qr_tokens_entry_active ON app.qr_tokens(entry_ticket_id)
  WHERE lifecycle_state = 'ACTIVE' AND entry_ticket_id IS NOT NULL;
CREATE UNIQUE INDEX ux_qr_tokens_karaoke_active ON app.qr_tokens(karaoke_ticket_id)
  WHERE lifecycle_state = 'ACTIVE' AND karaoke_ticket_id IS NOT NULL;

-- SEC-DB-001 / SEC-DB-003 / SPEC-140 §39 / SPEC-180 §22.2-22.4 / SPEC-100 §53; DB-FK-004 / SPEC-100 §12: no runtime
-- role may remove rows. No mounted Operation reads or writes these tables yet (Ticket issuance, QR display and
-- check-in come with later PRs), so no role gets a grant here (plan U-5). The PR that mounts an Operation adds what
-- it needs; identity sequences need no grant.
REVOKE ALL ON app.entry_tickets, app.qr_tokens, app.entry_checkins
  FROM PUBLIC, app_runtime, app_api_runtime, app_email_runtime, app_reconciliation_runtime;
