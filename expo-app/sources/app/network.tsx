import * as React from 'react';
import {
  View, Text, TouchableOpacity, ScrollView,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { httpService } from '@/services/http';
import { candidatesFor, endpointInfo } from '@/services/discovery';
import { buildChainTargets, hostOf, shortHash, type ChainTarget, type ChainRole } from '@/lib/chainstatus';
import type { ChainProbe } from '@/lib/endpoints';

/**
 * Chains page: every L0 candidate plus every configured L1 chain / L1 candidate,
 * each probed with the same `getChainNumber` health rule the request layer uses
 * (services/discovery.`endpointInfo`). Polls every 30s while open; tap a row to
 * reveal the full chain state (length, finalized length, epochs, head/finalized
 * block) plus the node's peer count / id, fetched on demand.
 */

const POLL_MS = 30_000;
const CONCURRENCY = 5;

type Status = 'checking' | 'online' | 'offline';

interface Health {
  status: Status;
  latencyMs: number;
  probe: ChainProbe | null;
}

interface PeersInfo {
  count: number;
  self: string;
}

async function runPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: width }, async () => {
      while (next < items.length) {
        const item = items[next++];
        await fn(item);
      }
    }),
  );
}

interface StatusTheme {
  colors: { success: string; error: string; warning: string };
}

function statusColor(status: Status, theme: StatusTheme): string {
  if (status === 'online') return theme.colors.success;
  if (status === 'offline') return theme.colors.error;
  return theme.colors.warning;
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={s.detailRow}>
      <Text style={s.detailLabel}>{label}</Text>
      <Text style={s.detailValue} numberOfLines={1}>{value}</Text>
    </View>
  );
}

function ChainRow({ target, health, peers, expanded, onPress }: {
  target: ChainTarget;
  health?: Health;
  peers?: PeersInfo | 'loading';
  expanded: boolean;
  onPress: () => void;
}) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const status: Status = health?.status ?? 'checking';
  const probe = health?.probe ?? null;
  const dash = '-';
  const peersValue = peers === 'loading'
    ? t('network.checking')
    : peers
      ? `${peers.count} · ${shortHash(peers.self)}`
      : dash;
  return (
    <TouchableOpacity
      style={s.row}
      onPress={onPress}
      activeOpacity={0.6}
      accessibilityRole="button"
      accessibilityLabel={`${target.name} ${hostOf(target.url)}`}
      testID="network-row"
    >
      <View style={[s.dot, { backgroundColor: statusColor(status, theme) }]} testID={`network-status-${status}`} />
      <View style={s.rowMain}>
        <Text style={s.rowName} numberOfLines={1}>{target.name}</Text>
        <Text style={s.rowHost} numberOfLines={1}>{hostOf(target.url)}</Text>
        {expanded ? (
          <View style={s.detail} testID="network-detail">
            <DetailRow label={t('network.url')} value={target.url} />
            <DetailRow label={t('network.status')} value={t(`network.${status}`)} />
            <DetailRow label={t('network.chainLength')} value={probe ? String(probe.chainLength) : dash} />
            <DetailRow label={t('network.finalizedLength')} value={probe?.finalizedChainLength != null ? String(probe.finalizedChainLength) : dash} />
            <DetailRow
              label={t('network.epochs')}
              value={`${probe?.justifiedEpoch ?? dash} / ${probe?.finalizedEpoch ?? dash}`}
            />
            <DetailRow label={t('network.head')} value={probe?.head ? shortHash(probe.head, 10) : dash} />
            <DetailRow label={t('network.finalizedBlock')} value={probe?.finalizedBlockHash ? shortHash(probe.finalizedBlockHash, 10) : dash} />
            <DetailRow label={t('network.latencyLabel')} value={health?.status === 'online' ? t('network.latency', { ms: health.latencyMs }) : dash} />
            <DetailRow label={t('network.peers')} value={peersValue} />
          </View>
        ) : null}
      </View>
      <Text style={[s.rowValue, { color: statusColor(status, theme) }]}>
        {status === 'online' ? t('network.latency', { ms: health?.latencyMs ?? 0 }) : t(`network.${status}`)}
      </Text>
    </TouchableOpacity>
  );
}

export default function NetworkScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const [targets, setTargets] = React.useState<ChainTarget[]>([]);
  const [health, setHealth] = React.useState<Record<string, Health>>({});
  const [peers, setPeers] = React.useState<Record<string, PeersInfo | 'loading'>>({});
  // Details are shown by default; this tracks the rows the user collapsed.
  const [collapsed, setCollapsed] = React.useState<Set<string>>(() => new Set());

  const check = React.useCallback(async (list: ChainTarget[]) => {
    setHealth((prev) => {
      const next = { ...prev };
      for (const target of list) next[target.key] = { status: 'checking', latencyMs: 0, probe: null };
      return next;
    });
    await runPool(list, CONCURRENCY, async (target) => {
      const info = await endpointInfo(target.url);
      setHealth((prev) => ({
        ...prev,
        [target.key]: info
          ? { status: 'online', latencyMs: info.latencyMs, probe: info.probe }
          : { status: 'offline', latencyMs: 0, probe: null },
      }));
    });
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    const rebuild = () => {
      const list = buildChainTargets(
        candidatesFor('l0'),
        httpService.getL1Chains(),
        candidatesFor('l1'),
      );
      if (cancelled) return;
      setTargets(list);
      void check(list);
    };
    rebuild();
    const unsub = httpService.subscribeL1Change(rebuild);
    const timer = setInterval(rebuild, POLL_MS);
    return () => {
      cancelled = true;
      unsub();
      clearInterval(timer);
    };
  }, [check]);

  const loadPeers = React.useCallback(async (target: ChainTarget) => {
    setPeers((prev) => ({ ...prev, [target.key]: 'loading' }));
    const res = await httpService.request<PeersInfo>('getPeers', 'POST', {}, target.url);
    setPeers((prev) => ({
      ...prev,
      [target.key]: res.success && res.data
        ? { count: Number(res.data.count) || 0, self: res.data.self || '' }
        : { count: -1, self: '' },
    }));
  }, []);

  // Details are expanded by default, so load peers for every reachable row that
  // is visible and not already loaded (once per row).
  React.useEffect(() => {
    for (const target of targets) {
      if (
        !collapsed.has(target.key) &&
        health[target.key]?.status === 'online' &&
        !peers[target.key]
      ) {
        void loadPeers(target);
      }
    }
  }, [targets, health, collapsed, peers, loadPeers]);

  const toggle = (target: ChainTarget) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(target.key)) next.delete(target.key);
      else next.add(target.key);
      return next;
    });
  };

  const roleGroups: ChainRole[] = ['l0', 'l1'];

  return (
    <View style={s.container} testID="network-screen">
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn} accessibilityRole="button" accessibilityLabel={t('common.back')}>
          <Text style={s.backText}>←</Text>
        </TouchableOpacity>
        <Text style={s.pageTitle}>{t('sidebar.chains')}</Text>
      </View>

      <ScrollView contentContainerStyle={s.content}>
        {targets.length === 0 ? (
          <Text style={s.empty}>{t('network.empty')}</Text>
        ) : roleGroups.map((role) => {
          const rows = targets.filter((target) => target.role === role);
          if (rows.length === 0) return null;
          return (
            <View key={role} style={s.section}>
              <Text style={s.sectionTitle}>{t(`network.${role}`)}</Text>
              {rows.map((target) => (
                <ChainRow
                  key={target.key}
                  target={target}
                  health={health[target.key]}
                  peers={peers[target.key]}
                  expanded={!collapsed.has(target.key)}
                  onPress={() => toggle(target)}
                />
              ))}
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create((theme) => ({
  container: { flex: 1, backgroundColor: theme.colors.groupped.background },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 14 },
  backBtn: { padding: 4 },
  backText: { fontSize: 22, color: theme.colors.text.link, fontWeight: '700' },
  pageTitle: { fontSize: 20, fontWeight: '700', color: theme.colors.text.primary },
  content: { padding: 16, paddingTop: 4 },
  section: { marginBottom: 18 },
  sectionTitle: {
    fontSize: 11, fontWeight: '700', letterSpacing: 0.8, textTransform: 'uppercase',
    color: theme.colors.text.secondary, marginBottom: 8,
  },
  row: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 10,
    backgroundColor: theme.colors.groupped.surface, borderRadius: 10,
    borderWidth: 1, borderColor: theme.colors.border,
    paddingHorizontal: 12, paddingVertical: 12, marginBottom: 8,
  },
  dot: { width: 9, height: 9, borderRadius: 5, marginTop: 4 },
  rowMain: { flex: 1 },
  rowName: { fontSize: 14, fontWeight: '600', color: theme.colors.text.primary },
  rowHost: { fontSize: 12, color: theme.colors.text.secondary, marginTop: 2 },
  rowValue: { fontSize: 12, fontWeight: '600', marginTop: 1 },
  detail: {
    marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: theme.colors.border, gap: 4,
  },
  detailRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  detailLabel: { fontSize: 11, color: theme.colors.text.secondary },
  detailValue: { fontSize: 11, color: theme.colors.text.primary, fontFamily: 'monospace', flexShrink: 1, textAlign: 'right' },
  empty: { fontSize: 14, color: theme.colors.text.secondary, textAlign: 'center', padding: 32 },
}));
