/**
 * MeshCorePacketMonitorView — OTA packet monitor for a MeshCore source.
 *
 * The MeshCore analogue of the Meshtastic Packet Monitor. Surfaces full OTA
 * packet metadata captured from the companion `LogRxData` (0x88) push:
 * route type, payload type, relay-hash chain, hop count, SNR/RSSI and the
 * raw hex dump. Capture is opt-in via the `meshcore_packet_log_enabled`
 * setting; this view exposes the toggle and retention controls inline.
 *
 * Data flow: initial page is fetched from
 * `GET /api/sources/:id/meshcore/packets`; new packets arrive live over the
 * shared Socket.io connection as `meshcore:ota-packet` events (the room is
 * already joined by the parent MeshCorePage's useMeshCore hook).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Filter, Trash2, Pause, Play, RefreshCw, Download, Circle, Square, CheckSquare } from 'lucide-react';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
import { useWebSocketContext } from '../../contexts/WebSocketContext';
import { useAuth } from '../../contexts/AuthContext';
import type { MeshCoreOtaPacketEvent } from '../../hooks/useWebSocket';
import {
  MESHCORE_PAYLOAD_TYPES as PAYLOAD_TYPES,
  MESHCORE_ROUTE_TYPES as ROUTE_TYPES,
  decodeMeshCorePacket,
} from '../../utils/meshcorePacketDecode';
import MeshCorePacketDetailModal from './MeshCorePacketDetailModal';
import './MeshCorePacketMonitor.css';

interface MeshCorePacketMonitorViewProps {
  baseUrl: string;
  sourceId: string;
}

type Packet = MeshCoreOtaPacketEvent;

/**
 * One collapsed row: a distinct frame with its per-observer receptions folded
 * in (#5040 Phase 2b). Shares the display fields of `Packet` so the table body
 * can render either shape.
 */
interface GroupedPacket extends Packet {
  observerCount: number;
  receptionCount: number;
  bestSnr: number | null;
  bestRssi: number | null;
  firstHeard: number;
  lastHeard: number;
}

const MAX_BUFFER = 2000;

/**
 * Render an observer count for display.
 *
 * `0` does NOT mean "nobody heard this" — it means OUR radio heard it, because
 * a local reception carries a NULL observerId and COUNT(DISTINCT) skips NULLs
 * (#5040 Phase 2). Showing the digit would invert the meaning for every
 * locally-heard packet, so the local case gets a word instead.
 */
function observerLabel(count: number, localText: string): string {
  return count > 0 ? String(count) : localText;
}

function payloadLabel(p: Packet): string {
  if (p.payloadTypeName) return p.payloadTypeName;
  const match = PAYLOAD_TYPES.find(t => t.value === p.payloadType);
  return match ? match.label : `0x${p.payloadType.toString(16).padStart(2, '0')}`;
}

function routeLabel(p: Packet): string {
  if (p.routeTypeName) return p.routeTypeName;
  if (typeof p.routeType !== 'number') return '—';
  const match = ROUTE_TYPES.find(t => t.value === p.routeType);
  return match ? match.label : `0x${p.routeType.toString(16).padStart(2, '0')}`;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function getPacketKey(p: Packet, idx: number): string {
  if (p.id !== undefined && p.id !== null) return String(p.id);
  if (p.rawHex && p.timestamp) return `${p.timestamp}-${p.rawHex}`;
  return `${p.timestamp}-${idx}`;
}

function downloadBlob(blob: Blob, filename: string) {
  const blobUrl = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = blobUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(blobUrl);
}

function getDecodedSummary(p: Packet): string {
  const dec = decodeMeshCorePacket(p.rawHex);
  if (!dec) return '';
  if (dec.payload.advert?.name) {
    const adv = dec.payload.advert;
    const parts = [`Name: ${adv.name}`];
    if (adv.latitude !== undefined && adv.longitude !== undefined) {
      parts.push(`Pos: ${adv.latitude.toFixed(5)}, ${adv.longitude.toFixed(5)}`);
    }
    if (adv.advTypeName) parts.push(`Type: ${adv.advTypeName}`);
    return parts.join(' | ');
  }
  if (dec.payload.ack?.ackCodeHex) {
    return `ACK code: 0x${dec.payload.ack.ackCodeHex}`;
  }
  if (dec.payload.groupText) {
    return `Channel Hash: ${dec.payload.groupText.channelHash}`;
  }
  if (dec.payload.message) {
    return `Dest: ${dec.payload.message.destHash}, Src: ${dec.payload.message.srcHash}`;
  }
  return '';
}

export const MeshCorePacketMonitorView: React.FC<MeshCorePacketMonitorViewProps> = ({ baseUrl, sourceId }) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const { state: wsState } = useWebSocketContext();
  const socket = wsState.socket;
  const { hasPermission } = useAuth();

  // 'settings' is sourcey (Phase 6 #4416). Deviates from the PHASE6 spec §5.3
  // table's suggested `{ sourceId }` default: verified that saveSettings()
  // below POSTs `meshcore_packet_log_enabled` to /api/settings with no
  // sourceId query param, and the backend reads it via a plain
  // getSettingAsync() (meshcorePacketLogService.ts) — it is a genuinely
  // global, not per-source, setting, and this component never calls
  // useSource() (sourceId arrives as a prop). anySource mirrors the
  // unscoped write it actually gates.
  const canWriteSettings = hasPermission('settings', 'write', { anySource: true });
  const canClear = hasPermission('packetmonitor', 'write');

  const [packets, setPackets] = useState<Packet[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [showFilters, setShowFilters] = useState(false);

  const [enabled, setEnabled] = useState(false);
  const [maxCount, setMaxCount] = useState(1000);
  const [maxAgeHours, setMaxAgeHours] = useState(24);
  const [savingSettings, setSavingSettings] = useState(false);

  // Collapsed view (#5040 Phase 2b). Meaningful for any MeshCore source: a
  // device-backed one records a single reception per frame, so grouping is a
  // no-op there rather than something to hide behind a source-type check.
  const [grouped, setGrouped] = useState(false);
  const [groupedPackets, setGroupedPackets] = useState<GroupedPacket[]>([]);
  const [isIngestSource, setIsIngestSource] = useState(false);

  const [payloadFilter, setPayloadFilter] = useState<number | ''>('');
  const [routeFilter, setRouteFilter] = useState<number | ''>('');
  const [selectedPacket, setSelectedPacket] = useState<Packet | null>(null);

  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [lastSelectedIdx, setLastSelectedIdx] = useState<number | null>(null);
  const headerCheckboxRef = useRef<HTMLInputElement>(null);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement>(null);

  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const groupedRef = useRef(grouped);
  groupedRef.current = grouped;
  const reloadRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!showExportMenu) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setShowExportMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showExportMenu]);

  const mcPrefix = `${baseUrl}/api/sources/${encodeURIComponent(sourceId)}/meshcore`;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Don't send an explicit limit: let the server apply the configured
      // meshcore_packet_log_max_count as the effective page size (issue #3690).
      const params = new URLSearchParams();
      if (payloadFilter !== '') params.set('payload_type', String(payloadFilter));
      if (routeFilter !== '') params.set('route_type', String(routeFilter));
      const path = grouped ? 'packets/grouped' : 'packets';
      const res = await csrfFetch(`${mcPrefix}/${path}?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (grouped) {
        setGroupedPackets(Array.isArray(data.packets) ? data.packets : []);
      } else {
        setPackets(Array.isArray(data.packets) ? data.packets : []);
      }
      if (typeof data.enabled === 'boolean') setEnabled(data.enabled);
      if (typeof data.maxCount === 'number') setMaxCount(data.maxCount);
      if (typeof data.maxAgeHours === 'number') setMaxAgeHours(data.maxAgeHours);
      if (typeof data.isIngestSource === 'boolean') setIsIngestSource(data.isIngestSource);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load packets');
    } finally {
      setLoading(false);
    }
  }, [csrfFetch, mcPrefix, payloadFilter, routeFilter, grouped]);

  // Initial load + reload on filter change.
  useEffect(() => {
    void load();
  }, [load]);

  // Live updates: prepend incoming OTA packets matching the active filters.
  useEffect(() => {
    if (!socket) return;
    const onOtaPacket = (evt: MeshCoreOtaPacketEvent) => {
      if (evt.sourceId && evt.sourceId !== sourceId) return;
      if (pausedRef.current) return;
      // Grouping is a server-side aggregation: a new reception should increment
      // an existing group, not prepend a row. Prepending would show the same
      // frame twice and contradict the counts, so reload instead.
      if (groupedRef.current) {
        void reloadRef.current?.();
        return;
      }
      setPackets(prev => {
        const next = [evt, ...prev];
        return next.length > MAX_BUFFER ? next.slice(0, MAX_BUFFER) : next;
      });
    };
    socket.on('meshcore:ota-packet', onOtaPacket);
    return () => {
      socket.off('meshcore:ota-packet', onOtaPacket);
    };
  }, [socket, sourceId]);

  const visiblePackets = useMemo(() => {
    // Grouped rows arrive already filtered and aggregated by the server; the
    // client-side filter exists only to keep live-prepended rows honest in flat
    // mode, and re-applying it to groups would be a no-op at best.
    if (grouped) return groupedPackets as Packet[];
    return packets.filter(p => {
      if (payloadFilter !== '' && p.payloadType !== payloadFilter) return false;
      if (routeFilter !== '' && p.routeType !== routeFilter) return false;
      return true;
    });
  }, [grouped, groupedPackets, packets, payloadFilter, routeFilter]);

  // Let the live-packet handler trigger a reload without re-subscribing the
  // socket on every `load` identity change.
  reloadRef.current = load;

  const saveSettings = useCallback(async (patch: Record<string, string>): Promise<boolean> => {
    setSavingSettings(true);
    try {
      const res = await csrfFetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings');
      return false;
    } finally {
      setSavingSettings(false);
    }
  }, [csrfFetch, baseUrl]);

  const handleToggleEnabled = useCallback(async () => {
    // Commit the toggle only after the save succeeds, so a failed POST leaves
    // the control showing the real capture state instead of an optimistic lie.
    const next = !enabled;
    if (await saveSettings({ meshcore_packet_log_enabled: next ? '1' : '0' })) {
      setEnabled(next);
    }
  }, [enabled, saveSettings]);

  const handleClear = useCallback(async () => {
    if (!window.confirm(t('meshcore.packets.clearConfirm', 'Clear the captured MeshCore packet log for this source?'))) {
      return;
    }
    try {
      const res = await csrfFetch(`${mcPrefix}/packets`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setPackets([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clear packets');
    }
  }, [csrfFetch, mcPrefix, t]);

  // Selection computations
  const selectedVisiblePackets = useMemo(() => {
    return visiblePackets.filter((p, idx) => selectedKeys.has(getPacketKey(p, idx)));
  }, [visiblePackets, selectedKeys]);

  const allVisibleSelected = visiblePackets.length > 0 && selectedVisiblePackets.length === visiblePackets.length;
  const someVisibleSelected = selectedVisiblePackets.length > 0 && !allVisibleSelected;

  useEffect(() => {
    if (headerCheckboxRef.current) {
      headerCheckboxRef.current.indeterminate = someVisibleSelected;
    }
  }, [someVisibleSelected]);

  const handleToggleSelectAll = useCallback(() => {
    if (allVisibleSelected) {
      setSelectedKeys(prev => {
        const next = new Set(prev);
        visiblePackets.forEach((p, idx) => next.delete(getPacketKey(p, idx)));
        return next;
      });
    } else {
      setSelectedKeys(prev => {
        const next = new Set(prev);
        visiblePackets.forEach((p, idx) => next.add(getPacketKey(p, idx)));
        return next;
      });
    }
  }, [allVisibleSelected, visiblePackets]);

  const handleRowSelect = useCallback((key: string, index: number, shiftKey: boolean) => {
    setSelectedKeys(prev => {
      const next = new Set(prev);
      if (shiftKey && lastSelectedIdx !== null && lastSelectedIdx !== index && lastSelectedIdx < visiblePackets.length) {
        const start = Math.min(lastSelectedIdx, index);
        const end = Math.max(lastSelectedIdx, index);
        for (let i = start; i <= end; i++) {
          next.add(getPacketKey(visiblePackets[i], i));
        }
      } else {
        if (next.has(key)) {
          next.delete(key);
        } else {
          next.add(key);
        }
      }
      return next;
    });
    setLastSelectedIdx(index);
  }, [lastSelectedIdx, visiblePackets]);

  const handleClearSelection = useCallback(() => {
    setSelectedKeys(new Set());
    setLastSelectedIdx(null);
  }, []);

  const exportCsv = useCallback((packetsToExport: Packet[], prefixName: string) => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const headers = [
      'Timestamp',
      'ISO Time',
      'Payload Type',
      'Route Type',
      'Hop Count',
      'SNR',
      'RSSI',
      'Payload Size',
      'Path',
      'Observers',
      'Raw Hex',
      'Decoded Summary',
    ];

    const escapeCsv = (val: unknown): string => {
      if (val === null || val === undefined) return '';
      const str = String(val);
      if (/[",\n\r]/.test(str)) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    const rows = packetsToExport.map(p => {
      const obsCount = (p as GroupedPacket).observerCount !== undefined
        ? (p as GroupedPacket).observerCount
        : '';
      return [
        p.timestamp,
        new Date(p.timestamp).toISOString(),
        payloadLabel(p),
        routeLabel(p),
        typeof p.hopCount === 'number' ? p.hopCount : '',
        typeof p.snr === 'number' ? p.snr.toFixed(2) : '',
        typeof p.rssi === 'number' ? p.rssi : '',
        typeof p.payloadSize === 'number' ? p.payloadSize : '',
        p.pathHops || (p.pathLenRaw === 255 ? 'direct' : ''),
        obsCount,
        p.rawHex ?? '',
        getDecodedSummary(p),
      ].map(escapeCsv).join(',');
    });

    const csvContent = '\uFEFF' + [headers.join(','), ...rows].join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    downloadBlob(blob, `${prefixName}-${timestamp}.csv`);
  }, []);

  const exportJsonl = useCallback((packetsToExport: Packet[], prefixName: string) => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const lines = packetsToExport.map(p => {
      const decoded = decodeMeshCorePacket(p.rawHex);
      return JSON.stringify({ ...p, decoded });
    });
    const blob = new Blob([lines.join('\n') + '\n'], { type: 'application/x-ndjson' });
    downloadBlob(blob, `${prefixName}-${timestamp}.jsonl`);
  }, []);

  // Download the captured packet log as JSONL (honors the active filters),
  // mirroring the Meshtastic packet-monitor export.
  const handleExport = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (payloadFilter !== '') params.set('payload_type', String(payloadFilter));
      if (routeFilter !== '') params.set('route_type', String(routeFilter));
      const res = await csrfFetch(`${mcPrefix}/packets/export?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      // Prefer the server-provided filename (timestamped, filter-aware).
      const contentDisposition = res.headers.get('Content-Disposition');
      let filename = 'meshcore-packet-monitor.jsonl';
      const matches = contentDisposition && /filename="(.+)"/.exec(contentDisposition);
      if (matches && matches[1]) filename = matches[1];

      const blob = await res.blob();
      const blobUrl = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(blobUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to export packets');
    }
  }, [csrfFetch, mcPrefix, payloadFilter, routeFilter]);

  const handleExportSelected = useCallback((format: 'jsonl' | 'csv') => {
    if (selectedVisiblePackets.length === 0) return;
    if (format === 'jsonl') {
      exportJsonl(selectedVisiblePackets, 'meshcore-packets-selected');
    } else {
      exportCsv(selectedVisiblePackets, 'meshcore-packets-selected');
    }
    setShowExportMenu(false);
  }, [selectedVisiblePackets, exportJsonl, exportCsv]);

  const handleExportAll = useCallback(async (format: 'jsonl' | 'csv') => {
    setShowExportMenu(false);
    if (format === 'csv') {
      exportCsv(visiblePackets, 'meshcore-packets');
      return;
    }
    await handleExport();
  }, [exportCsv, visiblePackets, handleExport]);

  return (
    <div className="meshcore-packet-monitor">
      <div className="mcpm-header">
        <h3>{t('meshcore.packets.title', 'Packet Monitor')}</h3>
        <span className="mcpm-count">{visiblePackets.length}</span>
        <div className="mcpm-header-controls">
          {canWriteSettings && (
            <button
              className={`mcpm-btn ${enabled ? 'mcpm-btn-danger' : ''}`}
              onClick={() => void handleToggleEnabled()}
              disabled={savingSettings}
              title={enabled
                ? t('meshcore.packets.stopCapture', 'Stop capturing')
                : t('meshcore.packets.startCapture', 'Start capturing')}
            >
              {enabled ? <Square size={14} /> : <Circle size={14} />}
            </button>
          )}
          <button
            className="mcpm-btn"
            onClick={() => setPaused(p => !p)}
            title={paused ? t('common.resume', 'Resume') : t('common.pause', 'Pause')}
          >
            {paused ? <Play size={14} /> : <Pause size={14} />}
          </button>
          <button
            className={`mcpm-btn ${grouped ? 'active' : ''}`}
            onClick={() => setGrouped(g => !g)}
            title={grouped
              ? t('meshcore.packets.ungroupHelp', 'Show every reception separately')
              : t('meshcore.packets.groupHelp', 'Collapse receptions of the same frame into one row')}
          >
            {grouped
              ? t('meshcore.packets.grouped', 'Grouped')
              : t('meshcore.packets.flat', 'All')}
          </button>
          <button
            className={`mcpm-btn ${showFilters ? 'active' : ''}`}
            onClick={() => setShowFilters(s => !s)}
            title={t('common.filters', 'Filters')}
          >
            <Filter size={14} />
          </button>
          <button className="mcpm-btn" onClick={() => void load()} title={t('common.refresh', 'Refresh')}>
            <RefreshCw size={14} />
          </button>
          <div className="mcpm-export-wrapper" ref={exportMenuRef}>
            <button
              className={`mcpm-btn ${showExportMenu ? 'active' : ''}`}
              onClick={() => setShowExportMenu(s => !s)}
              title={t('common.export', 'Export')}
              aria-label={t('common.export', 'Export')}
            >
              <Download size={14} />
            </button>
            {showExportMenu && (
              <div className="mcpm-dropdown-menu">
                {selectedVisiblePackets.length > 0 && (
                  <>
                    <div className="mcpm-dropdown-header">
                      {t('meshcore.packets.exportSelectedHeader', 'Selected ({{count}})', { count: selectedVisiblePackets.length })}
                    </div>
                    <button
                      type="button"
                      className="mcpm-dropdown-item"
                      onClick={() => handleExportSelected('jsonl')}
                    >
                      <Download size={13} />
                      {t('meshcore.packets.exportSelectedJsonl', 'Export Selected (JSONL)')}
                    </button>
                    <button
                      type="button"
                      className="mcpm-dropdown-item"
                      onClick={() => handleExportSelected('csv')}
                    >
                      <Download size={13} />
                      {t('meshcore.packets.exportSelectedCsv', 'Export Selected (CSV)')}
                    </button>
                    <div className="mcpm-dropdown-divider" />
                  </>
                )}
                <div className="mcpm-dropdown-header">
                  {t('meshcore.packets.exportAllHeader', 'All ({{count}})', { count: visiblePackets.length })}
                </div>
                <button
                  type="button"
                  className="mcpm-dropdown-item"
                  onClick={() => void handleExportAll('jsonl')}
                >
                  <Download size={13} />
                  {t('meshcore.packets.exportAllJsonl', 'Export All (JSONL)')}
                </button>
                <button
                  type="button"
                  className="mcpm-dropdown-item"
                  onClick={() => void handleExportAll('csv')}
                >
                  <Download size={13} />
                  {t('meshcore.packets.exportAllCsv', 'Export All (CSV)')}
                </button>
              </div>
            )}
          </div>
          {canClear && (
            <button className="mcpm-btn mcpm-btn-danger" onClick={() => void handleClear()} title={t('common.clear', 'Clear')}>
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>

      {!enabled && (
        <div className="mcpm-disabled-banner">
          <span>
            {t('meshcore.packets.disabled', 'MeshCore packet capture is off. No new packets will be recorded until you enable it.')}
          </span>
          {canWriteSettings && (
            <button className="mcpm-btn" disabled={savingSettings} onClick={() => void handleToggleEnabled()}>
              {t('meshcore.packets.enable', 'Enable capture')}
            </button>
          )}
        </div>
      )}

      {showFilters && (
        <div className="mcpm-filters">
          <label>
            {t('meshcore.packets.payloadType', 'Payload')}
            <select value={payloadFilter} onChange={e => setPayloadFilter(e.target.value === '' ? '' : Number(e.target.value))}>
              <option value="">{t('common.all', 'All')}</option>
              {PAYLOAD_TYPES.map(pt => (
                <option key={pt.value} value={pt.value}>{pt.label}</option>
              ))}
            </select>
          </label>
          <label>
            {t('meshcore.packets.routeType', 'Route')}
            <select value={routeFilter} onChange={e => setRouteFilter(e.target.value === '' ? '' : Number(e.target.value))}>
              <option value="">{t('common.all', 'All')}</option>
              {ROUTE_TYPES.map(rt => (
                <option key={rt.value} value={rt.value}>{rt.label}</option>
              ))}
            </select>
          </label>
          {canWriteSettings && (
            <>
              <label className="mcpm-toggle">
                <input type="checkbox" checked={enabled} disabled={savingSettings} onChange={() => void handleToggleEnabled()} />
                {t('meshcore.packets.captureEnabled', 'Capture enabled')}
              </label>
              <label>
                {t('meshcore.packets.maxCount', 'Max count')}
                <input
                  type="number"
                  min={100}
                  max={isIngestSource ? 500000 : 50000}
                  step={100}
                  value={maxCount}
                  onChange={e => setMaxCount(Number(e.target.value))}
                  onBlur={() => void saveSettings(
                    // Retention is per-source-kind (#5040): an MQTT region feed
                    // writes one row per observer and has its own key, so
                    // writing the device key here would silently cap the wrong
                    // sources.
                    isIngestSource
                      ? { meshcore_mqtt_packet_log_max_count: String(maxCount) }
                      : { meshcore_packet_log_max_count: String(maxCount) },
                  )}
                />
              </label>
              {isIngestSource && (
                <span className="mcpm-setting-warning">
                  {t(
                    'meshcore.packets.ingestCapWarning',
                    'A region feed stores one row per observer that heard each frame. At 50,000 rows expect roughly 50–100MB of database per source — noticeable on a Pi or a small container volume.',
                  )}
                </span>
              )}
              <label>
                {t('meshcore.packets.maxAgeHours', 'Max age (h)')}
                <input
                  type="number"
                  min={1}
                  max={720}
                  value={maxAgeHours}
                  onChange={e => setMaxAgeHours(Number(e.target.value))}
                  onBlur={() => void saveSettings({ meshcore_packet_log_max_age_hours: String(maxAgeHours) })}
                />
              </label>
            </>
          )}
        </div>
      )}

      {error && <div className="mcpm-error">{error}</div>}

      {selectedVisiblePackets.length > 0 && (
        <div className="mcpm-selection-bar">
          <div className="mcpm-selection-info">
            <CheckSquare size={15} />
            <span>
              {t('meshcore.packets.selectedCount', '{{count}} packet(s) selected', { count: selectedVisiblePackets.length })}
            </span>
            {selectedVisiblePackets.length < visiblePackets.length && (
              <button
                type="button"
                className="mcpm-btn-link"
                onClick={() => {
                  setSelectedKeys(new Set(visiblePackets.map((p, i) => getPacketKey(p, i))));
                }}
              >
                {t('meshcore.packets.selectAllVisible', 'Select all visible ({{count}})', { count: visiblePackets.length })}
              </button>
            )}
            <button
              type="button"
              className="mcpm-btn-link"
              onClick={handleClearSelection}
            >
              {t('common.clearSelection', 'Clear selection')}
            </button>
          </div>
          <div className="mcpm-selection-actions">
            <button
              type="button"
              className="mcpm-btn mcpm-btn-sm"
              onClick={() => handleExportSelected('jsonl')}
              title={t('meshcore.packets.exportSelectedJsonl', 'Export selected packets as JSONL')}
            >
              <Download size={13} />
              <span>JSONL</span>
            </button>
            <button
              type="button"
              className="mcpm-btn mcpm-btn-sm"
              onClick={() => handleExportSelected('csv')}
              title={t('meshcore.packets.exportSelectedCsv', 'Export selected packets as CSV')}
            >
              <Download size={13} />
              <span>CSV</span>
            </button>
          </div>
        </div>
      )}

      <div className="mcpm-table-container">
        {loading ? (
          <div className="mcpm-empty">{t('common.loading', 'Loading…')}</div>
        ) : visiblePackets.length === 0 ? (
          <div className="mcpm-empty">
            {enabled
              ? t('meshcore.packets.empty', 'No packets captured yet. Waiting for OTA traffic…')
              : t('meshcore.packets.emptyDisabled', 'No packets captured. Enable capture to start recording.')}
          </div>
        ) : (
          <table className="mcpm-table">
            <thead>
              <tr>
                <th className="mcpm-th-checkbox">
                  <input
                    type="checkbox"
                    className="mcpm-checkbox"
                    ref={headerCheckboxRef}
                    checked={allVisibleSelected}
                    onChange={handleToggleSelectAll}
                    title={t('meshcore.packets.selectAll', 'Select all visible packets')}
                    aria-label={t('meshcore.packets.selectAll', 'Select all visible packets')}
                  />
                </th>
                <th>{t('meshcore.packets.time', 'Time')}</th>
                <th>{t('meshcore.packets.payloadType', 'Payload')}</th>
                <th>{t('meshcore.packets.routeType', 'Route')}</th>
                <th>{t('meshcore.packets.hops', 'Hops')}</th>
                <th>{t('meshcore.packets.snr', 'SNR')}</th>
                <th>{t('meshcore.packets.rssi', 'RSSI')}</th>
                <th>{t('meshcore.packets.size', 'Size')}</th>
                {grouped && (
                  <th title={t('meshcore.packets.observersHelp', 'Distinct observers that heard this frame. "Local" means your own radio heard it.')}>
                    {t('meshcore.packets.observers', 'Observers')}
                  </th>
                )}
                <th>{t('meshcore.packets.path', 'Path')}</th>
              </tr>
            </thead>
            <tbody>
              {visiblePackets.map((p, idx) => {
                const key = getPacketKey(p, idx);
                const isSelected = selectedKeys.has(key);
                return (
                  <tr
                    key={key}
                    className={`mcpm-row ${isSelected ? 'mcpm-row-selected' : ''}`}
                    onClick={() => setSelectedPacket(p)}
                    title={t('meshcore.packets.clickToDecode', 'Click to decode this packet')}
                  >
                    <td
                      className="mcpm-td-checkbox"
                      onClick={e => {
                        e.stopPropagation();
                        handleRowSelect(key, idx, e.shiftKey);
                      }}
                    >
                      <input
                        type="checkbox"
                        className="mcpm-checkbox"
                        checked={isSelected}
                        onChange={e => {
                          e.stopPropagation();
                        }}
                        onClick={e => {
                          e.stopPropagation();
                          handleRowSelect(key, idx, (e.nativeEvent as MouseEvent).shiftKey);
                        }}
                        aria-label={`Select packet ${key}`}
                      />
                    </td>
                    <td className="mcpm-mono">{formatTime(p.timestamp)}</td>
                    <td><span className="mcpm-badge">{payloadLabel(p)}</span></td>
                    <td className="mcpm-route">{routeLabel(p)}</td>
                    <td className="mcpm-mono">{typeof p.hopCount === 'number' ? p.hopCount : '—'}</td>
                    <td className="mcpm-mono">{typeof p.snr === 'number' ? p.snr.toFixed(2) : '—'}</td>
                    <td className="mcpm-mono">{typeof p.rssi === 'number' ? p.rssi : '—'}</td>
                    <td className="mcpm-mono">{typeof p.payloadSize === 'number' ? p.payloadSize : '—'}</td>
                    {grouped && (
                      <td className="mcpm-mono">
                        {observerLabel(
                          Number((p as GroupedPacket).observerCount ?? 0),
                          t('meshcore.packets.observersLocal', 'Local'),
                        )}
                      </td>
                    )}
                    <td className="mcpm-mono mcpm-path">{p.pathHops || (p.pathLenRaw === 255 ? 'direct' : '—')}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {selectedPacket &&
        createPortal(
          <MeshCorePacketDetailModal packet={selectedPacket} onClose={() => setSelectedPacket(null)} />,
          document.body
        )}
    </div>
  );
};

export default MeshCorePacketMonitorView;
