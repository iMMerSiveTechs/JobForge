// ─── EstimateListScreen ───────────────────────────────────────────────────────
// All estimates, sorted by most recent. Tap to open detail, + to create new.
import React, { useState, useCallback, useRef } from 'react';
import {
  View, Text, TouchableOpacity, FlatList, StyleSheet,
  SafeAreaView, ActivityIndicator,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Estimate } from '../models/types';
import { EstimateRepository } from '../storage/repository';
import { ALL_VERTICALS } from '../config/verticals';
import { T, radii } from '../theme';

function deriveJobStageLabel(est: Estimate): string {
  const { status, followUpStatus, quoteSentAt } = est;
  if (followUpStatus === 'won')                                    return 'Won';
  if (followUpStatus === 'lost' || status === 'rejected')          return 'Lost';
  if (status === 'accepted')                                       return 'Approved';
  if (followUpStatus === 'follow_up_due')                          return 'Follow-up Due';
  if (followUpStatus === 'awaiting_customer')                      return 'Awaiting';
  if (followUpStatus === 'appointment_scheduled')                  return 'Appt. Scheduled';
  if (followUpStatus === 'quote_sent' || quoteSentAt)              return 'Quote Sent';
  if (status === 'pending')                                        return 'Priced';
  return 'In Progress';
}

const STAGE_COLOR: Record<string, string> = {
  'Won':              T.green,
  'Approved':         T.green,
  'Lost':             T.red,
  'Follow-up Due':    T.red,
  'Awaiting':         T.amber,
  'Appt. Scheduled':  T.purple,
  'Quote Sent':       T.teal,
  'Priced':           T.amber,
  'In Progress':      T.sub,
};

export function EstimateListScreen({ navigation }: any) {
  const [estimates, setEstimates] = useState<Estimate[]>([]);
  const [loading, setLoading]     = useState(true);
  const isFirstLoad = useRef(true);

  const load = useCallback(() => {
    (async () => {
      if (isFirstLoad.current) setLoading(true);
      try {
        const list = await EstimateRepository.listEstimates();
        setEstimates(list);
      } finally {
        isFirstLoad.current = false;
        setLoading(false);
      }
    })();
  }, []);

  useFocusEffect(load);

  return (
    <SafeAreaView style={s.safe}>
      {loading ? (
        <ActivityIndicator style={{ marginTop: 60 }} color={T.accent} />
      ) : (
        <FlatList
          data={estimates}
          keyExtractor={e => e.id}
          contentContainerStyle={s.list}
          ListEmptyComponent={
            <View style={s.empty}>
              <Text style={s.emptyIcon}>📝</Text>
              <Text style={s.emptyTitle}>No jobs yet</Text>
              <Text style={s.emptySub}>
                Capture a lead, pick a service, and get a{'\n'}price range in minutes.
              </Text>
              <TouchableOpacity style={s.emptyBtn} onPress={() => navigation.navigate('NewEstimate')}>
                <Text style={s.emptyBtnTxt}>+ New Job</Text>
              </TouchableOpacity>
            </View>
          }
          renderItem={({ item: est }) => {
            const min = est.computedRange?.min ?? 0;
            const max = est.computedRange?.max ?? 0;
            const date = new Date(est.updatedAt);
            const vertical = ALL_VERTICALS.find(v => v.id === est.verticalId);
            const service  = vertical?.services.find(s => s.id === est.serviceId);
            const stageLabel = deriveJobStageLabel(est);
            const stageColor = STAGE_COLOR[stageLabel] ?? T.sub;
            const isFollowUpDue = est.followUpStatus === 'follow_up_due';
            return (
              <TouchableOpacity
                style={s.row}
                onPress={() => navigation.navigate('EstimateDetail', { estimateId: est.id })}
              >
                <View style={s.rowLeft}>
                  <Text style={s.customerName}>{est.customer.name}</Text>
                  {service && (
                    <Text style={s.serviceLabel}>{service.name}</Text>
                  )}
                  <Text style={s.dateText}>{date.toLocaleDateString()}</Text>
                </View>
                <View style={s.rowRight}>
                  <Text style={s.range}>
                    ${min.toLocaleString('en-US')}–${max.toLocaleString('en-US')}
                  </Text>
                  <View style={s.statusRow}>
                    {isFollowUpDue && (
                      <View style={s.urgencyPill}>
                        <Text style={s.urgencyTxt}>Follow-up</Text>
                      </View>
                    )}
                    <Text style={[s.status, { color: stageColor }]}>{stageLabel}</Text>
                  </View>
                </View>
                <Text style={s.arrow}>›</Text>
              </TouchableOpacity>
            );
          }}
        />
      )}
      <TouchableOpacity style={s.fab} onPress={() => navigation.navigate('NewEstimate')}>
        <Text style={s.fabTxt}>+</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: T.bg },
  list: { padding: 16, paddingBottom: 100 },
  empty: { marginTop: 80, alignItems: 'center', paddingHorizontal: 32 },
  emptyIcon: { fontSize: 48, marginBottom: 12 },
  emptyTitle: { color: T.text, fontSize: 18, fontWeight: '700', marginBottom: 8 },
  emptySub: { color: T.sub, fontSize: 14, textAlign: 'center', lineHeight: 20 },
  emptyBtn: { backgroundColor: T.accent, borderRadius: radii.md, paddingHorizontal: 24, paddingVertical: 12, marginTop: 16 },
  emptyBtnTxt: { color: '#fff', fontWeight: '700', fontSize: 15 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: T.surface, borderRadius: radii.md,
    padding: 14, borderWidth: 1, borderColor: T.border, marginBottom: 10,
  },
  rowLeft: { flex: 1 },
  customerName: { color: T.text, fontSize: 15, fontWeight: '600' },
  serviceLabel: { color: T.textDim, fontSize: 12, marginTop: 2 },
  dateText: { color: T.muted, fontSize: 11, marginTop: 2 },
  rowRight: { alignItems: 'flex-end' },
  range: { color: T.accent, fontSize: 13, fontWeight: '700' },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 3 },
  status: { fontSize: 11, fontWeight: '600' },
  urgencyPill: { backgroundColor: T.redLo, borderRadius: 4, paddingHorizontal: 5, paddingVertical: 2, borderWidth: 1, borderColor: T.red },
  urgencyTxt: { color: T.red, fontSize: 10, fontWeight: '700' },
  arrow: { color: T.sub, fontSize: 20 },
  fab: {
    position: 'absolute', bottom: 24, right: 20,
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: T.accent, alignItems: 'center', justifyContent: 'center',
    shadowColor: T.accent, shadowOpacity: 0.4, shadowRadius: 10, shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  fabTxt: { color: '#fff', fontSize: 28, fontWeight: '400', lineHeight: 32, marginTop: -1 },
});
