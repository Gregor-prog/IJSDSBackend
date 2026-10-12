-- Gate 2 is split between two accounts (Journal Manager, Parakletus). The split is the same
-- share for local and Global Card payments, so the parts must equal the amount collected. A
-- CHECK can't look at another table, so a trigger enforces "split total == linked payment".
CREATE OR REPLACE FUNCTION gate2_split_matches_payment() RETURNS trigger AS $$
DECLARE paid NUMERIC(10,2);
BEGIN
  SELECT amount_naira INTO paid FROM payment_ledger WHERE id = NEW.payment_ledger_id;
  IF paid IS NULL OR NEW.journal_manager_naira + NEW.parakletus_naira <> paid THEN
    RAISE EXCEPTION 'Gate 2 split (%) must equal the linked payment amount (%)',
      NEW.journal_manager_naira + NEW.parakletus_naira, paid;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_gate2_split_matches_payment
  BEFORE INSERT OR UPDATE ON "gate2_distribution_ledger"
  FOR EACH ROW EXECUTE FUNCTION gate2_split_matches_payment();
