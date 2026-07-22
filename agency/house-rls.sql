-- agentlytics agency — HOUSE row-level security (the memory-house multi-tenant model).
--
-- This is the ONE piece the agency owner (`agentlytics_root`) CANNOT install itself:
-- CREATE ROW POLICY requires ACCESS MANAGEMENT, which the kernel deliberately
-- withholds from agency owners. So the KERNEL applies this (running as `kernel`), or
-- the mayor applies it once out-of-band. Everything else is already in place:
--   * identity  — `user_id MATERIALIZED currentUser()` on raw (house-schema.sql)
--   * membership — kernel `register-member{handle}` mints the CH user + `member` role
--   * access     — owner `GRANT INSERT, SELECT ON agentlytics.* TO <handle>`
--   * ingest     — each member runs agency.js with THEIR OWN credential; the DB stamps
--                  user_id = <handle>, so their rows are theirs, un-spoofably.
--
-- Substitute `agentlytics` below with the agency/house name if the operator named it
-- differently.

-- OWN-ONLY isolation (memory-house's default): each member sees only their own rows.
-- Bound to the `member` role, so it applies to everyone the kernel registered. The
-- owner (not a member) is outside the policy and sees the whole house.
CREATE ROW POLICY IF NOT EXISTS own_rows ON agentlytics.raw
    FOR SELECT USING user_id = currentUser() TO member;

-- Views (messages_v / sessions_v) read `raw`, so they inherit the querying member's
-- policy automatically — no separate policy needed. If a physical FTS `messages`
-- table is later added (like memory-house), add the same policy TO member on it, since
-- a row policy binds to a physical table.

-- SHARED alternative (a common team pool where everyone sees everyone): install NO
-- restrictive policy — just the owner GRANT SELECT — and every member reads the whole
-- house. Do not combine with own_rows on the same role; pick one visibility model.
