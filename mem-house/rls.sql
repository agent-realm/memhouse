-- mem-house — own-only row-level security (the sharing model's isolation half).
--
-- Applied by the KERNEL (or the mayor, who has ACCESS MANAGEMENT) — the agency owner
-- cannot CREATE ROW POLICY by design. Binds to the kernel's `member` role, so every
-- registered member sees only their own rows; the owner (not a member) sees the whole
-- house. For a shared team pool instead, apply NO policy — just the owner's GRANTs.
--
-- Substitute `memhouse` if the operator named the house differently. Policies bind to
-- physical tables; views (sessions_v) inherit the querying user's policy via messages/
-- sessions.

CREATE ROW POLICY IF NOT EXISTS own_sessions ON memhouse.sessions
    FOR SELECT USING user_id = currentUser() TO member;
CREATE ROW POLICY IF NOT EXISTS own_messages ON memhouse.messages
    FOR SELECT USING user_id = currentUser() TO member;
CREATE ROW POLICY IF NOT EXISTS own_tool_calls ON memhouse.tool_calls
    FOR SELECT USING user_id = currentUser() TO member;
