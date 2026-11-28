-- PR-L1-2c0: runtime privileges for purchase eligibility and purchase start. Grants only: no table, column,
-- constraint, index or sequence changes (expand-only, DB-MIG-005), so the required catalog (schema-contract.json,
-- which records no ACL) is unchanged and a build that bundles an earlier migration set stays Ready (INF-HLT-006).
-- DB-MIG-002 / SPEC-100 §67 item 35: privileges are managed by versioned SQL migrations.
--
-- 0006, 0007 and 0008 granted nothing ("the PR that mounts an Operation adds what it needs"). This migration adds
-- that for API-PUR-ELG-001 (PR-L1-2b), the Entry purchase start (PR-L1-2c / 2d) and the Goods purchase start
-- (API-PUR-CART-001, a later PR; SPEC-200 §48). The Goods INSERT grants come before the code that uses them by
-- decision of the user (plan OI-1); SPEC-180 §22.2 allows what the Business API needs, so this is a work-order
-- decision, not a specification change. If the Goods PR needs another column it adds a new migration.
--
-- SEC-DB-001 / SEC-DB-003 / SPEC-140 §39 / SPEC-180 §22.2 / SPEC-100 §53: only app_api_runtime gets access, and only
-- table-level SELECT and column-level INSERT. Not granted, on purpose:
--  - UPDATE and row locks: release, commit and cancel belong to PR-L1-2e and L1-3 / L1-4, which add them.
--  - DELETE and TRUNCATE for every role (DB-FK-004, SPEC-100 §12, SPEC-180 §22.2): history is never removed.
--  - Writes to the Karaoke tables and order_items.karaoke_slot_id: API-PUR-KRK-001 is not mounted.
--  - checkout_attempts, payment_bindings, webhook_receipts, refund_records and the Ticket / Check-in / Handoff tables.
--  - Any other role and PUBLIC (SPEC-180 §22.3-22.4): the workers do not use these tables.
--  - Sequence privileges: identity values are generated without them (as in 0003 and 0005).
--  - The grant option (SEC-DB-002): the runtime cannot pass a privilege on.
-- INSERT is column-level, as for idempotency_records in 0005 (SPEC-100 §43.1): it leaves out the identity id, the
-- generated line_total_amount, public_ref (SPEC-100 §7.2 default), created_at / updated_at / held_at (DB-TIM-002
-- defaults) and the times written by a later transition (confirmed_at, terminal_at, committed_at, released_at). The
-- role guards which columns can be written, not their values: the repository decides the state (the CHECKs are the
-- last defence).

-- API-PUR-ELG-001 reads the Order, Entry, Goods and Karaoke rows; the Entry purchase start also reads order_items.
GRANT SELECT ON app.orders, app.order_items, app.entry_sales_allocations,
  app.karaoke_holds, app.karaoke_reservations,
  app.goods_order_items, app.goods_sales_allocations TO app_api_runtime;
-- SPEC-100 §16: a new Order is PREPARED; public_ref and the times come from defaults.
GRANT INSERT (purchase_cause_key, customer_profile_id, purpose, state, currency, total_amount)
  ON app.orders TO app_api_runtime;
-- SPEC-100 §17: entry_offering_id for an Entry item, goods_id for a Goods item (ck_order_items_source).
GRANT INSERT (order_id, purpose, line_no, quantity, unit_amount, currency, item_name_snapshot,
  entry_offering_id, goods_id) ON app.order_items TO app_api_runtime;
-- SPEC-100 §18: an Allocation starts HELD; held_at comes from the default.
GRANT INSERT (order_item_id, order_id, purpose, offering_id, quantity, state)
  ON app.entry_sales_allocations TO app_api_runtime;
-- SPEC-100 §39: a Goods Order Item starts PENDING_PAYMENT; the columns the composite foreign keys need.
GRANT INSERT (order_item_id, order_id, order_purpose, customer_profile_id, goods_id, state)
  ON app.goods_order_items TO app_api_runtime;
-- SPEC-100 §40: a Goods Allocation starts HELD; held_at comes from the 0008 default.
GRANT INSERT (goods_order_item_id, goods_id, quantity, state)
  ON app.goods_sales_allocations TO app_api_runtime;
