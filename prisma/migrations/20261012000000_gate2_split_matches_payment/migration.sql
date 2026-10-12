-- Global Card payments are split in the same proportions as the local ₦25,500 split, so the
-- parts must equal the amount collected rather than a fixed 25,500. A CHECK can't look at
-- another table, so a trigger enforces "split total == linked payment amount".
ALTER TABLE "gate2_distribution_ledger" DROP CONSTRAINT IF EXISTS "chk_gate2_split_totals_25500";

CREATE OR REPLACE FUNCTION gate2_split_matches_payment() RETURNS trigger AS $$
DECLARE paid NUMERIC(10,2);
BEGIN
  SELECT amount_naira INTO paid FROM payment_ledger WHERE id = NEW.payment_ledger_id;
  IF paid IS NULL OR NEW.tech_support_naira + NEW.designer_naira + NEW.journal_account_naira + NEW.journal_manager_naira <> paid THEN
    RAISE EXCEPTION 'Gate 2 split (%) must equal the linked payment amount (%)',
      NEW.tech_support_naira + NEW.designer_naira + NEW.journal_account_naira + NEW.journal_manager_naira, paid;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_gate2_split_matches_payment
  BEFORE INSERT OR UPDATE ON "gate2_distribution_ledger"
  FOR EACH ROW EXECUTE FUNCTION gate2_split_matches_payment();
