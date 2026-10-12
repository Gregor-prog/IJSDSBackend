import prisma from "../../config/prisma.js";
import { httpError } from "./ijsds2.constants.js";
import { getOrCreateReviewerProfile } from "./manuscripts.service.js";
import { createNotification } from "../notifications/notifications.service.js";

export const MIN_WITHDRAWAL_NAIRA = 1000;

const shape = (w) => ({ ...w, amount_naira: Number(w.amount_naira) });

export const requestWithdrawal = async (userId, { amount, bank_name, account_number, account_name }) => {
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt < MIN_WITHDRAWAL_NAIRA || Math.round(amt * 100) !== amt * 100) {
    throw httpError(400, `Minimum withdrawal is ₦${MIN_WITHDRAWAL_NAIRA.toLocaleString()}`);
  }
  if (!bank_name?.trim() || !/^\d{10}$/.test(String(account_number ?? "")) || !account_name?.trim()) {
    throw httpError(400, "bank_name, a 10-digit NUBAN account_number and account_name are required");
  }
  const rp = await getOrCreateReviewerProfile(userId);

  const row = await prisma.$transaction(async (tx) => {
    // Conditional debit: can never take the wallet below zero, even under concurrent requests.
    const debited = await tx.reviewerProfile.updateMany({
      where: { id: rp.id, wallet_balance_naira: { gte: amt } },
      data: { wallet_balance_naira: { decrement: amt } },
    });
    if (debited.count !== 1) throw httpError(409, "Insufficient wallet balance");
    return tx.referralWithdrawal.create({
      data: { reviewer_id: rp.id, amount_naira: amt, bank_name: bank_name.trim(), account_number, account_name: account_name.trim() },
    });
  });

  const admins = await prisma.profile.findMany({ where: { OR: [{ is_admin: true }, { role: "admin" }] }, select: { id: true } });
  await Promise.all(admins.map((a) => createNotification({ user_id: a.id, title: "Referral payout requested", message: `A reviewer requested a ₦${amt.toLocaleString()} referral payout.`, type: "info" }).catch(() => {})));
  return shape(row);
};

export const listMyWithdrawals = async (userId) => {
  const rp = await getOrCreateReviewerProfile(userId);
  const rows = await prisma.referralWithdrawal.findMany({
    where: { reviewer_id: rp.id },
    orderBy: { created_at: "desc" },
    take: 50,
    select: { id: true, amount_naira: true, status: true, note: true, created_at: true, processed_at: true },
  });
  return rows.map(shape);
};

export const listWithdrawals = async (status) => {
  const rows = await prisma.referralWithdrawal.findMany({
    where: status ? { status } : {},
    orderBy: { created_at: "asc" },
    take: 200,
    include: { reviewer: { select: { user: { select: { full_name: true, email: true } } } } },
  });
  return rows.map((r) => shape({ ...r, reviewer: r.reviewer.user }));
};

/** Admin marks a request PAID (after the manual transfer) or REJECTED (wallet refunded). */
export const processWithdrawal = async (id, { outcome, note }, admin) => {
  if (!["PAID", "REJECTED"].includes(outcome)) throw httpError(400, "outcome must be PAID or REJECTED");
  if (outcome === "REJECTED" && !note?.trim()) throw httpError(400, "A note is required when rejecting");

  const w = await prisma.$transaction(async (tx) => {
    const claimed = await tx.referralWithdrawal.updateMany({
      where: { id, status: "REQUESTED" },
      data: { status: outcome, processed_by: admin.id, processed_at: new Date(), note: note?.trim() ?? null },
    });
    if (claimed.count !== 1) throw httpError(409, "Request not found or already processed");
    const row = await tx.referralWithdrawal.findUnique({ where: { id }, include: { reviewer: { select: { user_id: true } } } });
    if (outcome === "REJECTED") {
      await tx.reviewerProfile.update({ where: { id: row.reviewer_id }, data: { wallet_balance_naira: { increment: row.amount_naira } } });
    }
    return row;
  });

  createNotification({
    user_id: w.reviewer.user_id,
    title: outcome === "PAID" ? "Referral payout sent" : "Referral payout rejected",
    message: outcome === "PAID" ? `₦${Number(w.amount_naira).toLocaleString()} has been paid out.` : `Your payout request was rejected and the amount returned to your wallet. ${note ?? ""}`,
    type: outcome === "PAID" ? "success" : "warning",
  }).catch(() => {});
  return shape({ ...w, reviewer: undefined });
};
