// ─── EstimateDetailScreen ─────────────────────────────────────────────────
import React, { useState, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  SafeAreaView, Alert, ActivityIndicator,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Estimate, Invoice, MaterialLineItem, AiScanRecord, AI_META_PREFIX, AnswerValue, FollowUpStatus, CommIntent, TimelineEventType } from '../models/types';
import { EstimateRepository } from '../storage/repository';
import { InvoiceRepository } from '../storage/invoices';
import { getAiHistory } from '../storage/aiHistory';
import { nextInvoiceNumber, getBusinessProfile } from '../storage/settings';
import { makeId } from '../domain/id';
import { TimelineRepository } from '../storage/timeline';
import { MaterialsSection } from '../components/MaterialsSection';
import { FollowUpPanel } from '../components/FollowUpPanel';
import { ReminderSheet } from '../components/ReminderSheet';
import { CommReviewModal } from '../components/CommReviewModal';
import { generateEstimatePdf, sharePdf } from '../services/pdfService';
import { intentToTimelineEvent } from '../services/commProvider';
import { T, radii } from '../theme';
import { ALL_VERTICALS } from '../config/verticals';

// ─── Derived lifecycle stage ───────────────────────────────────────────────────
// Pure function — no I/O. Derives a human-readable job stage from existing fields.
function deriveJobStage(est: Estimate): { label: string; color: string; bgColor: string } {
  const { status, followUpStatus, quoteSentAt } = est;
  if (followUpStatus === 'won')
    return { label: 'Won',             color: T.greenHi,  bgColor: T.greenLo };
  if (followUpStatus === 'lost' || status === 'rejected')
    return { label: 'Lost',            color: T.red,      bgColor: T.redLo };
  if (status === 'accepted')
    return { label: 'Approved',        color: T.greenHi,  bgColor: T.greenLo };
  if (followUpStatus === 'follow_up_due')
    return { label: 'Follow-up Due',   color: T.red,      bgColor: T.redLo };
  if (followUpStatus === 'awaiting_customer')
    return { label: 'Awaiting',        color: T.amberHi,  bgColor: T.amberLo };
  if (followUpStatus === 'appointment_scheduled')
    return { label: 'Appt. Scheduled', color: T.purple,   bgColor: T.purpleLo };
  if (followUpStatus === 'quote_sent' || quoteSentAt)
    return { label: 'Quote Sent',      color: T.teal,     bgColor: T.tealLo };
  if (status === 'pending')
    return { label: 'Priced',          color: T.amberHi,  bgColor: T.amberLo };
  return   { label: 'In Progress',     color: T.sub,      bgColor: T.surface };
}

// ─── Derived next action ───────────────────────────────────────────────────────
type NextAction = {
  icon: string;
  label: string;
  subtitle: string;
  action: 'edit' | 'send' | 'followUp' | 'invoice' | 'viewInvoice';
  urgent?: boolean;
  invoiceId?: string;
};

function deriveNextAction(est: Estimate, invs: Invoice[]): NextAction | null {
  const { status, followUpStatus, quoteSentAt } = est;
  if (status === 'rejected' || followUpStatus === 'lost') return null;
  if (followUpStatus === 'won' && invs.every(i => i.status === 'paid')) return null;

  if (status === 'draft')
    return { icon: '✏️', label: 'Finalize Estimate', subtitle: 'Review answers and calculate the price range', action: 'edit' };
  if (status === 'pending' && !quoteSentAt)
    return { icon: '📤', label: 'Send Quote', subtitle: 'Email the estimate to your customer', action: 'send' };
  if (followUpStatus === 'follow_up_due')
    return { icon: '📞', label: 'Follow Up Now', subtitle: "Customer hasn't responded — follow up today", action: 'followUp', urgent: true };
  if (followUpStatus === 'quote_sent' || (quoteSentAt && status === 'pending'))
    return { icon: '📞', label: 'Follow Up', subtitle: 'Check in with the customer about your quote', action: 'followUp' };
  if (followUpStatus === 'awaiting_customer')
    return { icon: '⏳', label: 'Waiting on Customer', subtitle: 'Follow up if no response soon', action: 'followUp' };
  if (status === 'accepted') {
    if (invs.length === 0)
      return { icon: '🧾', label: 'Create Invoice', subtitle: 'Job approved — time to send an invoice', action: 'invoice' };
    const draftInv = invs.find(i => i.status === 'draft');
    if (draftInv)
      return { icon: '🧾', label: 'Send Invoice', subtitle: 'Invoice created but not sent yet', action: 'viewInvoice', invoiceId: draftInv.id };
    const sentInv = invs.find(i => i.status === 'sent');
    if (sentInv)
      return { icon: '💰', label: 'Collect Payment', subtitle: 'Invoice sent — record payment when received', action: 'viewInvoice', invoiceId: sentInv.id };
  }
  return null;
}

// ─── Lifecycle summary ─────────────────────────────────────────────────────────
function buildLifecycleSummary(est: Estimate, invs: Invoice[]): string {
  const fmt = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const parts: string[] = ['Created ' + fmt(est.createdAt)];
  if (est.quoteSentAt) parts.push('Sent ' + fmt(est.quoteSentAt));
  if (invs.length > 0) {
    const inv = invs[0];
    parts.push(`${inv.invoiceNumber} ${inv.status}`);
    if (inv.amountPaid) parts.push(`$${inv.amountPaid.toLocaleString('en-US')} paid`);
  }
  return parts.join(' · ');
}

const STATUS_STYLE: Record<string, { bg: string; border: string; text: string; label: string }> = {
  draft:    { bg: T.surface,  border: T.border, text: T.sub,     label: 'Draft' },
  pending:  { bg: T.amberLo,  border: T.amber,  text: T.amberHi, label: 'Pending' },
  accepted: { bg: T.greenLo,  border: T.green,  text: T.greenHi, label: 'Accepted' },
  rejected: { bg: T.redLo,    border: T.red,    text: T.red,     label: 'Rejected' },
};

function StatusBadge({ status }: { status: string }) {
  const c = STATUS_STYLE[status] ?? STATUS_STYLE.draft;
  return (
    <View style={[sb.wrap, { backgroundColor: c.bg, borderColor: c.border }]}>
      <Text style={[sb.txt, { color: c.text }]}>{c.label}</Text>
    </View>
  );
}
const sb = StyleSheet.create({
  wrap: { borderRadius: radii.sm, paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1 },
  txt:  { fontSize: 12, fontWeight: '700' },
});

function SectionHeader({ title }: { title: string }) {
  return <Text style={sh.txt}>{title}</Text>;
}
const sh = StyleSheet.create({
  txt: { color: T.textDim, fontSize: 11, fontWeight: '700', letterSpacing: 1, textTransform: 'uppercase', marginTop: 28, marginBottom: 10 },
});

function AiScanHistorySection({ history, onRevert }: { history: AiScanRecord[]; onRevert: (r: AiScanRecord) => void }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? history : history.slice(0, 2);
  return (
    <View>
      {shown.map(rec => {
        const date = new Date(rec.createdAt);
        return (
          <View key={rec.id} style={aih.card}>
            <View style={aih.row}>
              <View style={{ flex: 1 }}>
                <Text style={aih.date}>{date.toLocaleDateString()} {date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</Text>
                <Text style={aih.summary} numberOfLines={2}>{rec.summary}</Text>
              </View>
              <TouchableOpacity style={aih.btn} onPress={() => Alert.alert('Revert Answers', 'Replace current answers with this AI snapshot?', [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Revert', style: 'destructive', onPress: () => onRevert(rec) },
              ])}
                accessibilityRole="button"
                accessibilityLabel={`Revert to AI snapshot from ${rec.createdAt}`}
              >
                <Text style={aih.btnTxt}>Revert</Text>
              </TouchableOpacity>
            </View>
          </View>
        );
      })}
      {history.length > 2 && (
        <TouchableOpacity onPress={() => setExpanded(e => !e)}
          accessibilityRole="button"
          accessibilityLabel={expanded ? 'Show fewer scans' : 'View all scans'}
        >
          <Text style={aih.more}>{expanded ? 'Show less' : `View all ${history.length} scans`}</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}
const aih = StyleSheet.create({
  card: { backgroundColor: T.surface, borderWidth: 1, borderColor: T.border, borderRadius: radii.md, padding: 12, marginBottom: 8 },
  row:  { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  date: { color: T.sub, fontSize: 11, marginBottom: 3 },
  summary: { color: T.textDim, fontSize: 12, lineHeight: 17 },
  btn: { backgroundColor: T.redLo, borderWidth: 1, borderColor: T.red, borderRadius: radii.sm, paddingHorizontal: 10, paddingVertical: 6 },
  btnTxt: { color: T.red, fontSize: 12, fontWeight: '700' },
  more: { color: T.sub, fontSize: 13, textAlign: 'center', paddingVertical: 8 },
});

export function EstimateDetailScreen({ route, navigation }: any) {
  const { estimateId } = route?.params ?? {};
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [aiHistory, setAiHistory] = useState<AiScanRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showReminder, setShowReminder] = useState(false);
  const [showComm, setShowComm] = useState(false);
  const [commIntent, setCommIntent] = useState<CommIntent>('follow_up');
  const [pdfUri, setPdfUri] = useState<string | null>(null);
  const [generatingPdf, setGeneratingPdf] = useState(false);
  const [expandedDrivers, setExpandedDrivers] = useState<Record<string, boolean>>({});

  const load = useCallback(() => {
    (async () => {
      if (!estimateId) return;
      setLoading(true);
      try {
        const [est, invs, hist] = await Promise.all([
          EstimateRepository.getEstimate(estimateId),
          InvoiceRepository.listByEstimate(estimateId),
          getAiHistory(estimateId),
        ]);
        setEstimate(est);
        setInvoices(invs);
        setAiHistory(hist);
      } finally {
        setLoading(false);
      }
    })();
  }, [estimateId]);

  useFocusEffect(load);

  if (loading) {
    return <SafeAreaView style={s.safe}><ActivityIndicator style={{ marginTop: 60 }} color={T.accent} /></SafeAreaView>;
  }
  if (!estimate) {
    return <SafeAreaView style={s.safe}><Text style={s.notFound}>Estimate not found.</Text></SafeAreaView>;
  }

  const { computedRange: range, customer } = estimate;
  const hasOverrides = Object.keys(estimate.driverOverrides ?? {}).length > 0;
  const vertical = ALL_VERTICALS.find(v => v.id === estimate.verticalId);
  const service  = vertical?.services.find(s => s.id === estimate.serviceId);
  const jobStage = deriveJobStage(estimate);
  const nextAction = deriveNextAction(estimate, invoices);
  const lifecycleSummary = buildLifecycleSummary(estimate, invoices);

  const handleNextAction = () => {
    if (!nextAction) return;
    switch (nextAction.action) {
      case 'edit':       navigation.navigate('NewEstimate', { estimateId: estimate.id }); break;
      case 'send':       handleSendEstimate(); break;
      case 'followUp':   setCommIntent('follow_up'); setShowComm(true); break;
      case 'invoice':    handleCreateInvoice(); break;
      case 'viewInvoice': navigation.navigate('Invoice', { invoiceId: nextAction.invoiceId }); break;
    }
  };
  const materialsTotal = (estimate.materialLineItems ?? []).reduce((s, m) => s + m.unitCost * m.quantity, 0);
  const priceMin = (range?.min ?? 0) + materialsTotal;
  const priceMax = (range?.max ?? 0) + materialsTotal;

  const handleCreateInvoice = async () => {
    setSaving(true);
    try {
      const num = await nextInvoiceNumber();
      const driverItems = estimate.drivers
        .filter(d => !d.disabled)
        .map(d => ({
          id: d.id,
          label: d.label,
          unitCost: Math.round(((d.overrideMin ?? d.minImpact) + (d.overrideMax ?? d.maxImpact)) / 2),
          quantity: 1,
        }));
      const materialItems = (estimate.materialLineItems ?? []).map(m => ({
        id: m.id,
        label: m.name,
        unitCost: m.unitCost,
        quantity: m.quantity,
      }));
      const inv: Invoice = {
        id: makeId(),
        invoiceNumber: num,
        estimateId: estimate.id,
        estimateNumber: estimate.estimateNumber,
        customerId: estimate.customerId,
        customer: estimate.customer,
        status: 'draft',
        lineItems: [...driverItems, ...materialItems],
        taxRate: 0,
        paymentTerms: 'Due on receipt',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await InvoiceRepository.upsertInvoice(inv);
      if (estimate.customerId) {
        await TimelineRepository.appendEvent({
          customerId: estimate.customerId,
          estimateId: estimate.id,
          invoiceId: inv.id,
          type: 'invoice_created',
          note: `Invoice ${inv.invoiceNumber} created`,
        });
      }
      navigation.navigate('Invoice', { invoiceId: inv.id });
    } catch (err: any) {
      Alert.alert('Error', err?.message ?? 'Could not create invoice. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveMaterials = async (items: MaterialLineItem[]) => {
    const updated = { ...estimate, materialLineItems: items, updatedAt: new Date().toISOString() };
    setEstimate(updated as Estimate);
    await EstimateRepository.upsertEstimate(updated as Estimate);
  };

  const handleRevert = async (record: AiScanRecord) => {
    const cleaned: Record<string, AnswerValue> = {};
    for (const [k, v] of Object.entries(record.answersSnapshot)) {
      if (!k.startsWith(AI_META_PREFIX)) cleaned[k] = v;
    }
    const updated = { ...estimate, intakeAnswers: cleaned, updatedAt: new Date().toISOString() };
    setEstimate(updated as Estimate);
    await EstimateRepository.upsertEstimate(updated as Estimate);
  };

  const handleDelete = () => {
    Alert.alert('Delete Estimate', 'This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        await EstimateRepository.deleteEstimate(estimate.id);
        navigation.goBack();
      }},
    ]);
  };

  const handleStatusChange = async (status: Estimate['status']) => {
    const updated = { ...estimate, status, updatedAt: new Date().toISOString() };
    setEstimate(updated as Estimate);
    await EstimateRepository.upsertEstimate(updated as Estimate);
  };

  const handleExportPdf = async () => {
    setGeneratingPdf(true);
    try {
      const profile = await getBusinessProfile();
      const result = await generateEstimatePdf(estimate, profile);
      if (result.ok) {
        setPdfUri(result.fileUri);
        await sharePdf(result.fileUri, `Estimate ${estimate.estimateNumber ?? ''}`);
      } else {
        Alert.alert('PDF Error', result.error);
      }
    } catch (e: any) {
      Alert.alert('Error', e?.message ?? 'Could not generate PDF.');
    } finally {
      setGeneratingPdf(false);
    }
  };

  const handleSendEstimate = async () => {
    // Generate PDF first, then open comm modal with attachment
    setGeneratingPdf(true);
    try {
      const profile = await getBusinessProfile();
      const result = await generateEstimatePdf(estimate, profile);
      if (result.ok) {
        setPdfUri(result.fileUri);
      }
    } catch { /* PDF optional — continue without */ }
    setGeneratingPdf(false);
    setCommIntent('estimate_send');
    setShowComm(true);
  };

  const handleCommSent = async () => {
    const eventType = intentToTimelineEvent(commIntent) as TimelineEventType;
    if (commIntent === 'estimate_send') {
      const updated = { ...estimate, followUpStatus: 'quote_sent' as FollowUpStatus, quoteSentAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      setEstimate(updated as Estimate);
      await EstimateRepository.upsertEstimate(updated as Estimate);
    }
    if (estimate.customerId) {
      await TimelineRepository.appendEvent({
        customerId: estimate.customerId,
        estimateId: estimate.id,
        type: eventType,
        note: commIntent === 'estimate_send'
          ? `Estimate ${estimate.estimateNumber ?? ''} sent`
          : commIntent === 'follow_up'
          ? `Follow-up sent to ${estimate.customer?.name ?? ''}`
          : `Communication sent`,
      });
    }
    setShowComm(false);
    setPdfUri(null);
  };

  return (
    <SafeAreaView style={s.safe}>
      <ScrollView contentContainerStyle={s.scroll}>

        {/* Header card */}
        <View style={s.headerCard}>
          <View style={s.headerTop}>
            <View style={[s.stageBadge, { backgroundColor: jobStage.bgColor, borderColor: jobStage.color + '88' }]}>
              <Text style={[s.stageBadgeTxt, { color: jobStage.color }]}>{jobStage.label}</Text>
            </View>
            {estimate.estimateNumber && <Text style={s.estNum}>{estimate.estimateNumber}</Text>}
          </View>
          <Text style={s.customerName}>{customer?.name ?? '—'}</Text>
          {vertical && service && (
            <Text style={s.serviceLabel}>{vertical.name} · {service.name}</Text>
          )}
          {customer?.address && <Text style={s.customerSub}>{customer.address}</Text>}
          {customer?.phone && <Text style={s.customerSub}>{customer.phone}</Text>}
          <View style={s.headerBadges}>
            {estimate.quoteSentAt && (
              <View style={[s.badge, { backgroundColor: T.tealLo, borderColor: T.teal }]}>
                <Text style={[s.badgeTxt, { color: T.teal }]}>Sent {new Date(estimate.quoteSentAt).toLocaleDateString()}</Text>
              </View>
            )}
            {(estimate.photos?.length ?? 0) > 0 && (
              <View style={s.badge}>
                <Text style={s.badgeTxt}>📸 {estimate.photos!.length} photo{estimate.photos!.length !== 1 ? 's' : ''}</Text>
              </View>
            )}
            {aiHistory.length > 0 && (
              <View style={[s.badge, s.badgeAi]}>
                <Text style={[s.badgeTxt, s.badgeTxtAi]}>🤖 {aiHistory.length} AI scan{aiHistory.length !== 1 ? 's' : ''}</Text>
              </View>
            )}
          </View>
        </View>

        {/* Lifecycle summary */}
        <Text style={s.lifecycleSummary}>{lifecycleSummary}</Text>

        {/* Next Action */}
        {nextAction && (
          <TouchableOpacity
            style={[s.nextActionCard, nextAction.urgent && s.nextActionCardUrgent]}
            onPress={handleNextAction}
            disabled={saving || generatingPdf}
            accessibilityRole="button"
            accessibilityLabel={nextAction.label}
          >
            <Text style={s.nextActionIcon}>{nextAction.icon}</Text>
            <View style={{ flex: 1 }}>
              <Text style={[s.nextActionLabel, nextAction.urgent && { color: T.red }]}>{nextAction.label}</Text>
              <Text style={s.nextActionSub}>{nextAction.subtitle}</Text>
            </View>
            <Text style={[s.nextActionArrow, nextAction.urgent && { color: T.red }]}>→</Text>
          </TouchableOpacity>
        )}

        {/* Price range */}
        <SectionHeader title="Estimated Range" />
        <View style={s.priceCard}>
          <Text style={s.priceRange}>
            ${priceMin.toLocaleString('en-US')} – ${priceMax.toLocaleString('en-US')}
          </Text>
          {hasOverrides && <Text style={s.edited}>Edited</Text>}
          {materialsTotal > 0 && (
            <Text style={s.priceSub}>Includes ${materialsTotal.toLocaleString('en-US', { minimumFractionDigits: 2 })} materials</Text>
          )}
        </View>

        {/* Status actions */}
        <SectionHeader title="Status" />
        <View style={s.statusRow}>
          {(['draft', 'pending', 'accepted', 'rejected'] as Estimate['status'][]).map(st => {
            const c = STATUS_STYLE[st];
            const active = estimate.status === st;
            return (
              <TouchableOpacity
                key={st}
                style={[s.statusBtn, active && { backgroundColor: c.bg, borderColor: c.border }]}
                onPress={() => handleStatusChange(st)}
                accessibilityRole="button"
                accessibilityLabel={`Set status to ${c.label}`}
              >
                <Text style={[s.statusBtnTxt, active && { color: c.text }]}>{c.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Follow-up panel */}
        <SectionHeader title="Follow-up" />
        <FollowUpPanel
          status={estimate.followUpStatus}
          nextActionAt={estimate.nextActionAt}
          nextActionNote={estimate.nextActionNote}
          onStatusChange={async (status: FollowUpStatus) => {
            const updated = { ...estimate, followUpStatus: status, updatedAt: new Date().toISOString() };
            setEstimate(updated as Estimate);
            await EstimateRepository.upsertEstimate(updated as Estimate);
            if (estimate.customerId) await TimelineRepository.appendEvent({ customerId: estimate.customerId, estimateId: estimate.id, type: 'status_changed', note: `Follow-up → ${status}` });
          }}
          onNextActionChange={async (date, note) => {
            const updated = { ...estimate, nextActionAt: date, nextActionNote: note, updatedAt: new Date().toISOString() };
            setEstimate(updated as Estimate);
            await EstimateRepository.upsertEstimate(updated as Estimate);
          }}
          onMarkContacted={async () => {
            const now = new Date().toISOString();
            const updated = { ...estimate, lastContactAt: now, updatedAt: now };
            setEstimate(updated as Estimate);
            await EstimateRepository.upsertEstimate(updated as Estimate);
          }}
        />

        {/* Quick comms */}
        <View style={s.commRow}>
          <TouchableOpacity style={s.commBtn} onPress={() => setShowReminder(true)}
            accessibilityRole="button"
            accessibilityLabel="Reminder"
          >
            <Text style={s.commBtnTxt}>⏰ Reminder</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.commBtn} onPress={() => { setCommIntent('follow_up'); setShowComm(true); }}
            accessibilityRole="button"
            accessibilityLabel="Follow Up"
          >
            <Text style={s.commBtnTxt}>✉️ Follow Up</Text>
          </TouchableOpacity>
        </View>


        {/* Line items */}
        {estimate.drivers.length > 0 && (
          <>
            <SectionHeader title={`Line Items (${estimate.drivers.filter(d => !d.disabled).length})`} />
            {estimate.drivers.filter(d => !d.disabled).map(d => {
              const isExpanded = !!expandedDrivers[d.id];
              const hasExplanation = !!d.explanation;
              return (
                <TouchableOpacity
                  key={d.id}
                  style={s.driverRow}
                  onPress={() => hasExplanation && setExpandedDrivers(prev => ({ ...prev, [d.id]: !prev[d.id] }))}
                  activeOpacity={hasExplanation ? 0.7 : 1}
                  accessibilityRole="button"
                  accessibilityLabel={isExpanded ? `Collapse ${d.label}` : `Expand ${d.label}`}
                >
                  <View style={{ flex: 1, marginRight: 10 }}>
                    <Text style={s.driverLabel}>{d.label}</Text>
                    {isExpanded && hasExplanation && (
                      <Text style={s.driverExplanation}>{d.explanation}</Text>
                    )}
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={s.driverAmt}>
                      ${(d.overrideMin ?? d.minImpact).toLocaleString('en-US')}–${(d.overrideMax ?? d.maxImpact).toLocaleString('en-US')}
                    </Text>
                    {hasExplanation && (
                      <Text style={s.driverChevron}>{isExpanded ? '▲' : '▼'}</Text>
                    )}
                  </View>
                </TouchableOpacity>
              );
            })}
          </>
        )}

        {/* Materials */}
        <SectionHeader title="Materials" />
        <MaterialsSection items={estimate.materialLineItems ?? []} onChange={handleSaveMaterials} />

        {/* Invoices */}
        {invoices.length > 0 && (
          <>
            <SectionHeader title={`Invoices (${invoices.length})`} />
            {invoices.map(inv => (
              <TouchableOpacity key={inv.id} style={s.invoiceRow} onPress={() => navigation.navigate('Invoice', { invoiceId: inv.id })}
                accessibilityRole="button"
                accessibilityLabel={`Open invoice ${inv.invoiceNumber}`}
              >
                <View style={{ flex: 1 }}>
                  <Text style={s.invoiceNum}>{inv.invoiceNumber}</Text>
                  <Text style={s.invoiceSub}>{inv.status.charAt(0).toUpperCase() + inv.status.slice(1)} · {inv.paymentTerms}</Text>
                </View>
                {inv.totalAmount != null && (
                  <Text style={s.invoiceAmt}>${inv.totalAmount.toLocaleString('en-US')}</Text>
                )}
                <Text style={s.invoiceArrow}>›</Text>
              </TouchableOpacity>
            ))}
          </>
        )}

        {/* AI Scan History */}
        {aiHistory.length > 0 && (
          <>
            <SectionHeader title="AI Scan History" />
            <AiScanHistorySection history={aiHistory} onRevert={handleRevert} />
          </>
        )}

        {/* Actions */}
        <SectionHeader title="Actions" />
        <View style={s.actions}>
          <TouchableOpacity style={s.actionBtn} onPress={() => navigation.navigate('NewEstimate', { estimateId: estimate.id })}
            accessibilityRole="button"
            accessibilityLabel="Edit Job"
          >
            <Text style={s.actionIcon}>✏️</Text>
            <Text style={s.actionTxt}>Edit Job</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.actionBtn} onPress={handleSendEstimate} disabled={generatingPdf}
            accessibilityRole="button"
            accessibilityLabel="Send Quote"
          >
            {generatingPdf ? <ActivityIndicator size="small" color={T.accent} /> : <Text style={s.actionIcon}>📤</Text>}
            <View style={{ flex: 1 }}>
              <Text style={s.actionTxt}>Send Quote</Text>
              {!estimate.customer?.email && (
                <Text style={s.actionHint}>No email on file — you can enter one when sending</Text>
              )}
            </View>
          </TouchableOpacity>
          <TouchableOpacity style={s.actionBtn} onPress={handleCreateInvoice} disabled={saving}
            accessibilityRole="button"
            accessibilityLabel="Create Invoice"
          >
            {saving ? <ActivityIndicator size="small" color={T.accent} /> : <Text style={s.actionIcon}>🧾</Text>}
            <Text style={s.actionTxt}>Create Invoice</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={s.actionBtn}
            onPress={() => navigation.navigate('AiSiteAnalysis', { estimateId: estimate.id, verticalId: estimate.verticalId, serviceId: estimate.serviceId })}
            accessibilityRole="button"
            accessibilityLabel="Site Photos / AI Analysis"
          >
            <Text style={s.actionIcon}>📸</Text>
            <View style={{ flex: 1 }}>
              <Text style={s.actionTxt}>Site Photos / AI Analysis</Text>
              {(estimate.photos?.length ?? 0) > 0 && (
                <Text style={s.actionHint}>{estimate.photos!.length} photo{estimate.photos!.length !== 1 ? 's' : ''} attached</Text>
              )}
            </View>
          </TouchableOpacity>
          <TouchableOpacity style={s.actionBtn} onPress={handleExportPdf} disabled={generatingPdf}
            accessibilityRole="button"
            accessibilityLabel="Export PDF"
          >
            {generatingPdf ? <ActivityIndicator size="small" color={T.accent} /> : <Text style={s.actionIcon}>📄</Text>}
            <Text style={s.actionTxt}>Export PDF</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[s.actionBtn, s.actionBtnDanger]} onPress={handleDelete}
            accessibilityRole="button"
            accessibilityLabel="Delete"
          >
            <Text style={s.actionIcon}>🗑️</Text>
            <Text style={[s.actionTxt, { color: T.red }]}>Delete</Text>
          </TouchableOpacity>
        </View>

      </ScrollView>

      <ReminderSheet
        visible={showReminder}
        initial={{
          estimateId: estimate.id,
          customerId: estimate.customerId,
          customerName: estimate.customer?.name ?? '',
          type: 'estimate_followup',
        }}
        onClose={() => setShowReminder(false)}
        onSaved={() => setShowReminder(false)}
      />

      <CommReviewModal
        visible={showComm}
        intent={commIntent}
        vars={{
          customer_name: estimate.customer?.name ?? '',
          business_name: undefined,
          address: estimate.customer?.address,
          estimate_number: estimate.estimateNumber,
          price_range: estimate.computedRange
            ? `$${estimate.computedRange.min.toLocaleString('en-US')} – $${estimate.computedRange.max.toLocaleString('en-US')}`
            : undefined,
        }}
        recipientEmail={estimate.customer?.email}
        attachments={pdfUri ? [pdfUri] : undefined}
        attachmentLabel={pdfUri ? `Estimate ${estimate.estimateNumber ?? ''} PDF` : undefined}
        onClose={() => { setShowComm(false); setPdfUri(null); }}
        onSent={handleCommSent}
      />
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: T.bg },
  scroll: { padding: 20, paddingBottom: 60 },
  notFound: { color: T.sub, fontSize: 16, textAlign: 'center', marginTop: 60 },

  headerCard: { backgroundColor: T.surface, borderRadius: radii.lg, padding: 18, borderWidth: 1, borderColor: T.border },
  headerTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  stageBadge: { borderRadius: radii.sm, paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1 },
  stageBadgeTxt: { fontSize: 12, fontWeight: '700' },
  estNum: { color: T.sub, fontSize: 12 },
  customerName: { color: T.text, fontSize: 22, fontWeight: '700' },
  serviceLabel: { color: T.textDim, fontSize: 13, fontWeight: '500', marginTop: 2 },
  customerSub: { color: T.sub, fontSize: 13, marginTop: 3 },
  headerBadges: { flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' },
  badge: { flexDirection: 'row', alignItems: 'center', backgroundColor: T.surface, borderWidth: 1, borderColor: T.border, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4 },
  badgeAi: { backgroundColor: T.indigoLo, borderColor: T.indigo },
  badgeTxt: { color: T.textDim, fontSize: 12, fontWeight: '600' },
  badgeTxtAi: { color: T.indigoHi },

  priceCard: { backgroundColor: T.surface, borderRadius: radii.lg, padding: 20, borderWidth: 1, borderColor: T.border, alignItems: 'center' },
  priceRange: { color: T.text, fontSize: 28, fontWeight: '800' },
  edited: { color: T.amberHi, fontSize: 12, fontWeight: '600', marginTop: 4 },
  priceSub: { color: T.sub, fontSize: 12, marginTop: 4 },

  statusRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  statusBtn: { borderWidth: 1, borderColor: T.border, borderRadius: radii.md, paddingHorizontal: 14, paddingVertical: 8 },
  statusBtnTxt: { color: T.sub, fontSize: 13, fontWeight: '600' },

  driverRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: T.border },
  driverLabel: { color: T.text, fontSize: 14 },
  driverExplanation: { color: T.sub, fontSize: 12, lineHeight: 17, marginTop: 4 },
  driverAmt: { color: T.text, fontSize: 13, fontWeight: '600' },
  driverChevron: { color: T.muted, fontSize: 9, marginTop: 4 },

  invoiceRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: T.surface, borderRadius: radii.md, padding: 14, borderWidth: 1, borderColor: T.border, marginBottom: 8 },
  invoiceNum: { color: T.text, fontSize: 15, fontWeight: '600' },
  invoiceSub: { color: T.sub, fontSize: 12, marginTop: 2 },
  invoiceAmt: { color: T.text, fontSize: 14, fontWeight: '700', marginRight: 8 },
  invoiceArrow: { color: T.sub, fontSize: 20 },

  lifecycleSummary: { color: T.sub, fontSize: 12, marginTop: 10, marginBottom: 2, paddingHorizontal: 2 },
  nextActionCard: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: T.accentLo, borderRadius: radii.lg, padding: 16, borderWidth: 1, borderColor: T.accent + '55', marginTop: 10 },
  nextActionCardUrgent: { backgroundColor: T.redLo, borderColor: T.red + '55' },
  nextActionIcon: { fontSize: 22 },
  nextActionLabel: { color: T.text, fontSize: 15, fontWeight: '700' },
  nextActionSub: { color: T.sub, fontSize: 12, marginTop: 2 },
  nextActionArrow: { color: T.accent, fontSize: 18, fontWeight: '700' },

  actions: { gap: 10 },
  actionBtn: { flexDirection: 'row', alignItems: 'center', gap: 14, backgroundColor: T.surface, borderRadius: radii.md, padding: 16, borderWidth: 1, borderColor: T.border },
  actionBtnDanger: { borderColor: T.redLo },
  actionIcon: { fontSize: 20 },
  actionTxt: { color: T.text, fontSize: 15, fontWeight: '600' },
  actionHint: { color: T.muted, fontSize: 11, marginTop: 2 },
  commRow: { flexDirection: 'row', gap: 10, marginTop: 4 },
  commBtn: { flex: 1, backgroundColor: T.surface, borderRadius: radii.md, paddingVertical: 12, alignItems: 'center', borderWidth: 1, borderColor: T.border },
  commBtnTxt: { color: T.text, fontSize: 13, fontWeight: '600' },
});
