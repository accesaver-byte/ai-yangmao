-- Additive: deploy before the new Worker; existing rejection rows remain valid.
ALTER TABLE rejected_offer_updates ADD COLUMN decision_key TEXT;
CREATE UNIQUE INDEX rejected_offer_updates_decision_key_unique ON rejected_offer_updates(decision_key);
