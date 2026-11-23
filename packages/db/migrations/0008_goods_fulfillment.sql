-- PR-GK-3: the Goods fulfillment tables (SPEC-100 §39-§41, §45.1, §45.6). Constraints and indexes carry explicit
-- names (DB-ARC-007); the partial pending-Handoff index is SQL-only DDL (SPEC-100 §57, DB-MIG-002). States are text
-- with a named allowlist CHECK and no default, so the repository always sets them (SPEC-100 §10, DB-STA-001..002);
-- the names are those of SPEC-030 §16.2, §16.3 and §17.1. Times are timestamptz; created_at, updated_at and held_at
-- default to transaction_timestamp() and updated_at is maintained by the repository, not by a trigger
-- (DB-TIM-001..003). Every foreign key is ON DELETE RESTRICT (DB-FK-002, SPEC-100 §11). No rows are created here,
-- and no trigger, function or existing object changes. No shipping address, carrier or tracking column is added
-- (SPEC-100 §15.3, BR-GDS-009). Goods purchase, commit, release and handoff transactions are not part of this
-- migration (simplified scope).

-- SPEC-100 §39 goods_order_items: the 1:1 fulfillment extension of a base Order Item, keyed by its id. The three
-- composite foreign keys keep the item's Order and Purpose, its customer (DB-GDS-002, BR-GDS-008) and its Goods equal
-- to the base item's and the Order's; their targets are the UNIQUE keys of 0006. uq_..._order_item_id_goods_id is
-- the target of the Allocation's Goods foreign key (§40).
CREATE TABLE app.goods_order_items (
 order_item_id bigint NOT NULL,
 public_ref uuid NOT NULL DEFAULT gen_random_uuid(),
 order_id bigint NOT NULL,
 order_purpose text NOT NULL,
 customer_profile_id bigint NOT NULL,
 goods_id bigint NOT NULL,
 state text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 CONSTRAINT pk_goods_order_items PRIMARY KEY (order_item_id),
 CONSTRAINT uq_goods_order_items_public_ref UNIQUE (public_ref),
 CONSTRAINT uq_goods_order_items_order_item_id_goods_id UNIQUE (order_item_id, goods_id),
 CONSTRAINT fk_goods_order_items_order_item FOREIGN KEY (order_item_id, order_id, order_purpose) REFERENCES app.order_items(id, order_id, purpose) ON DELETE RESTRICT,
 CONSTRAINT fk_goods_order_items_order_customer FOREIGN KEY (order_id, customer_profile_id) REFERENCES app.orders(id, customer_profile_id) ON DELETE RESTRICT,
 CONSTRAINT fk_goods_order_items_goods FOREIGN KEY (order_item_id, goods_id) REFERENCES app.order_items(id, goods_id) ON DELETE RESTRICT,
 CONSTRAINT ck_goods_order_items_order_purpose CHECK (order_purpose IN ('GOODS_PURCHASE','ENTRY_GOODS_PURCHASE')),
 CONSTRAINT ck_goods_order_items_state CHECK (state IN ('PENDING_PAYMENT','FULFILLABLE','CANCELED'))
);

-- SPEC-100 §40 goods_sales_allocations. One Allocation per Goods Order Item; the composite foreign key keeps its Goods
-- equal to the item's. Only the three states are checked: §40 defines no state / timestamp CHECK (plan U-1). The
-- Inventory counters change in the same transaction under a conditional update on state = 'HELD' (DB-GDS-003..004,
-- repository); no trigger does it.
CREATE TABLE app.goods_sales_allocations (
 id bigint GENERATED ALWAYS AS IDENTITY,
 goods_order_item_id bigint NOT NULL,
 goods_id bigint NOT NULL,
 quantity integer NOT NULL,
 state text NOT NULL,
 held_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 committed_at timestamptz,
 released_at timestamptz,
 CONSTRAINT pk_goods_sales_allocations PRIMARY KEY (id),
 CONSTRAINT uq_goods_sales_allocations_goods_order_item_id UNIQUE (goods_order_item_id),
 CONSTRAINT fk_goods_sales_allocations_goods_order_item FOREIGN KEY (goods_order_item_id) REFERENCES app.goods_order_items(order_item_id) ON DELETE RESTRICT,
 CONSTRAINT fk_goods_sales_allocations_goods FOREIGN KEY (goods_order_item_id, goods_id) REFERENCES app.goods_order_items(order_item_id, goods_id) ON DELETE RESTRICT,
 CONSTRAINT ck_goods_sales_allocations_quantity CHECK (quantity > 0),
 CONSTRAINT ck_goods_sales_allocations_state CHECK (state IN ('HELD','COMMITTED','RELEASED'))
);

-- SPEC-100 §41 goods_handoffs. One Handoff per Goods Order Item (BR-GDS-011). The state / timestamp CHECK is that of
-- §41; COMPLETED requires both actor columns (plan U-2). COMPLETED is never returned to PENDING (DB-GDS-005,
-- conditional update in the repository).
CREATE TABLE app.goods_handoffs (
 id bigint GENERATED ALWAYS AS IDENTITY,
 public_ref uuid NOT NULL DEFAULT gen_random_uuid(),
 goods_order_item_id bigint NOT NULL,
 state text NOT NULL,
 completed_by_profile_id bigint,
 completed_role_assignment_id bigint,
 completed_at timestamptz,
 voided_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 CONSTRAINT pk_goods_handoffs PRIMARY KEY (id),
 CONSTRAINT uq_goods_handoffs_public_ref UNIQUE (public_ref),
 CONSTRAINT uq_goods_handoffs_goods_order_item_id UNIQUE (goods_order_item_id),
 CONSTRAINT fk_goods_handoffs_goods_order_item FOREIGN KEY (goods_order_item_id) REFERENCES app.goods_order_items(order_item_id) ON DELETE RESTRICT,
 CONSTRAINT fk_goods_handoffs_completed_by_profile FOREIGN KEY (completed_by_profile_id) REFERENCES app.business_profiles(id) ON DELETE RESTRICT,
 CONSTRAINT fk_goods_handoffs_completed_role_assignment FOREIGN KEY (completed_role_assignment_id) REFERENCES app.role_assignments(id) ON DELETE RESTRICT,
 CONSTRAINT ck_goods_handoffs_state CHECK (state IN ('PENDING','COMPLETED','VOID')),
 CONSTRAINT ck_goods_handoffs_state_times CHECK (
   (state = 'PENDING' AND completed_at IS NULL AND voided_at IS NULL)
   OR (state = 'COMPLETED' AND completed_by_profile_id IS NOT NULL AND completed_role_assignment_id IS NOT NULL
       AND completed_at IS NOT NULL AND voided_at IS NULL)
   OR (state = 'VOID' AND voided_at IS NOT NULL AND completed_at IS NULL)
 )
);

-- SPEC-100 §45.1: Customer -> Goods Order Item.
CREATE INDEX ix_goods_order_items_customer_created ON app.goods_order_items(customer_profile_id, created_at DESC);
-- SPEC-100 §45.6: Allocations by Goods and state, and the Handoffs still pending.
CREATE INDEX ix_goods_allocations_goods_state ON app.goods_sales_allocations(goods_id, state);
CREATE INDEX ix_goods_handoffs_pending ON app.goods_handoffs(created_at) WHERE state = 'PENDING';

-- SEC-DB-001 / SEC-DB-003 / SPEC-140 §39 / SPEC-180 §22.2-22.4 / SPEC-100 §53; DB-FK-004 / SPEC-100 §12: no runtime
-- role may remove rows. No mounted Operation reads or writes these tables (the Goods purchase, self and handoff
-- Operations are outside the simplified scope; the public Goods read uses app.goods and app.goods_inventory only), so
-- no role gets a grant here (plan U-5). The PR that mounts an Operation adds what it needs.
REVOKE ALL ON app.goods_order_items, app.goods_sales_allocations, app.goods_handoffs
  FROM PUBLIC, app_runtime, app_api_runtime, app_email_runtime, app_reconciliation_runtime;
