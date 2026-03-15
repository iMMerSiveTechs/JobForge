// ─── AI credits + analysis history (Firestore-backed) ─────────────────────
// Credit balance: users/{uid}/credits/balance
// Analysis history: users/{uid}/analysisHistory/{recordId}
// Credit settings: users/{uid}/credits/settings
//
// In Phase 0 (demo), credits are never deducted.
// deductCredit() is wired for Phase 2 when the real AI backend goes live.
// purchaseCredits() uses a Stripe provider abstraction; demo mode when
// Stripe is not configured (stripeEnabled = false in integrations settings).

import {
  doc,
  getDoc,
  setDoc,
  collection,
  addDoc,
  getDocs,
  query,
  orderBy,
  serverTimestamp,
  increment,
  Timestamp,
} from 'firebase/firestore';
import { auth, db } from '../firebase/config';
import { CreditBalance, AnalysisRecord, AiCreditSettings, AutoReloadSettings, AI_CREDIT_PACKS } from '../models/types';

function uid(): string {
  if (!auth) throw new Error('aiCredits: Firebase not initialized — check EXPO_PUBLIC_FIREBASE_* env vars');
  const user = auth.currentUser;
  if (!user) throw new Error('aiCredits: user is not signed in');
  return user.uid;
}

function ensureDb() {
  if (!db) throw new Error('aiCredits: Firestore not initialized — check EXPO_PUBLIC_FIREBASE_* env vars');
  return db;
}

function balanceDoc() {
  return doc(ensureDb(), 'users', uid(), 'credits', 'balance');
}

function historyCol() {
  return collection(ensureDb(), 'users', uid(), 'analysisHistory');
}

export async function getCredits(): Promise<CreditBalance> {
  const snap = await getDoc(balanceDoc());
  if (!snap.exists()) {
    return { balance: 0, updatedAt: new Date().toISOString() };
  }
  const data = snap.data();
  const rawUpdatedAt = data.updatedAt;
  let updatedAt: string;
  if (rawUpdatedAt && typeof rawUpdatedAt.toDate === 'function') {
    updatedAt = rawUpdatedAt.toDate().toISOString();
  } else if (typeof rawUpdatedAt === 'string' && !isNaN(Date.parse(rawUpdatedAt))) {
    updatedAt = rawUpdatedAt;
  } else {
    updatedAt = new Date().toISOString();
  }
  return {
    balance: typeof data.balance === 'number' ? data.balance : 0,
    updatedAt,
  };
}

// Atomically subtract 1 credit. Throws if balance is 0.
export async function deductCredit(): Promise<void> {
  const { balance } = await getCredits();
  if (balance <= 0) throw new Error('Insufficient AI credits');
  await setDoc(balanceDoc(), { balance: increment(-1), updatedAt: serverTimestamp() }, { merge: true });
}

// Add credits (e.g. after purchase / admin grant)
export async function addCredits(amount: number): Promise<void> {
  await setDoc(balanceDoc(), { balance: increment(amount), updatedAt: serverTimestamp() }, { merge: true });
}

export async function getAnalysisHistory(): Promise<AnalysisRecord[]> {
  const q = query(historyCol(), orderBy('analyzedAt', 'desc'));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as AnalysisRecord));
}

export async function appendAnalysisRecord(
  record: Omit<AnalysisRecord, 'id'>,
): Promise<void> {
  await addDoc(historyCol(), { ...record, analyzedAt: serverTimestamp() });
}

// ─── Credit settings (auto-reload) ───────────────────────────────────────────

function settingsDoc() {
  return doc(ensureDb(), 'users', uid(), 'credits', 'settings');
}

export const DEFAULT_AUTO_RELOAD: AutoReloadSettings = {
  enabled: false,
  packId: 'pack_100',
  threshold: 5,
};

export async function getCreditSettings(): Promise<AiCreditSettings> {
  const snap = await getDoc(settingsDoc());
  if (!snap.exists()) {
    return { autoReload: DEFAULT_AUTO_RELOAD };
  }
  const data = snap.data();
  return {
    autoReload: { ...DEFAULT_AUTO_RELOAD, ...(data.autoReload ?? {}) },
    stripeCustomerId: data.stripeCustomerId,
  };
}

export async function saveCreditSettings(settings: AiCreditSettings): Promise<void> {
  await setDoc(settingsDoc(), { ...settings, updatedAt: serverTimestamp() }, { merge: true });
}

// ─── Credit purchase (Stripe stub) ───────────────────────────────────────────
// When Stripe is configured (integrations.stripeEnabled = true and
// integrations.stripePublishableKey is set), this initiates a real purchase.
// In demo/unconfigured mode, it throws with a clear "billing setup required" error.

export type PurchaseResult =
  | { success: true; creditsAdded: number; newBalance: number }
  | { success: false; errorType: 'billing_not_configured' | 'stripe_error' | 'user_cancelled'; message: string };

// Rate-limit purchases to prevent accidental double-taps or multiple rapid calls.
// Cooldown of 5 seconds between purchase attempts.
let _lastPurchaseAttempt = 0;
const PURCHASE_COOLDOWN_MS = 5000;

export async function purchaseCredits(
  packId: string,
  stripeEnabled: boolean,
): Promise<PurchaseResult> {
  const now = Date.now();
  if (now - _lastPurchaseAttempt < PURCHASE_COOLDOWN_MS) {
    return { success: false, errorType: 'stripe_error', message: 'Please wait a moment before trying again.' };
  }
  _lastPurchaseAttempt = now;
  const pack = AI_CREDIT_PACKS.find(p => p.id === packId);
  if (!pack) {
    return { success: false, errorType: 'stripe_error', message: `Unknown credit pack: ${packId}` };
  }

  if (!stripeEnabled) {
    // Billing not configured — do NOT simulate a real purchase
    return {
      success: false,
      errorType: 'billing_not_configured',
      message: 'Billing setup required. Configure your Stripe keys in Settings → Integrations to enable purchases.',
    };
  }

  // TODO: Replace with real Stripe payment sheet integration (react-native-stripe-sdk or similar).
  // Steps when Stripe is live:
  //   1. Call your backend to create a PaymentIntent for pack.price cents.
  //   2. Present Stripe payment sheet.
  //   3. On success, call addCredits(pack.credits) and appendAnalysisRecord.
  //   4. On failure, map Stripe error codes to user-safe messages.
  return {
    success: false,
    errorType: 'billing_not_configured',
    message: 'Stripe integration is enabled in settings but the payment flow is not yet connected. Finish wiring the Stripe SDK to complete purchases.',
  };
}

// ─── Auto-reload trigger ──────────────────────────────────────────────────────
// Call this after each AI action in Phase 2+.
// If balance <= threshold and autoReload is enabled, trigger a purchase.
// Returns true if a reload was triggered (even if it fails — caller should surface error).

export async function maybeAutoReload(stripeEnabled: boolean): Promise<boolean> {
  try {
    const [{ balance }, settings] = await Promise.all([getCredits(), getCreditSettings()]);
    const { autoReload } = settings;
    if (!autoReload.enabled) return false;
    if (balance > autoReload.threshold) return false;
    // Trigger purchase — result surfaced by caller
    await purchaseCredits(autoReload.packId, stripeEnabled);
    return true;
  } catch {
    return false;
  }
}
