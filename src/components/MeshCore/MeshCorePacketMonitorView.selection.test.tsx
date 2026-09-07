/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>, options?: Record<string, unknown>) => {
      const opts = typeof fallback === 'object' ? fallback : options;
      let text = typeof fallback === 'string' ? fallback : key;
      if (opts) {
        Object.entries(opts).forEach(([k, v]) => {
          text = text.replace(new RegExp(`{{${k}}}`, 'g'), String(v));
        });
      }
      return text;
    },
  }),
}));

let hasPermissionImpl: (resource: string, action: string) => boolean = () => true;
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ hasPermission: (r: string, a: string) => hasPermissionImpl(r, a) }),
}));

const csrfFetchMock = vi.fn();
vi.mock('../../hooks/useCsrfFetch', () => ({
  useCsrfFetch: () => csrfFetchMock,
}));

vi.mock('../../contexts/WebSocketContext', () => ({
  useWebSocketContext: () => ({ state: { socket: null } }),
}));

import { MeshCorePacketMonitorView } from './MeshCorePacketMonitorView';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('MeshCorePacketMonitorView packet selection and export', () => {
  const baseUrl = '';
  const sourceId = 'mc-1';

  const mockPackets = [
    {
      id: 1,
      sourceId: 'mc-1',
      timestamp: 1725600000000,
      payloadType: 4,
      payloadTypeName: 'ADVERT',
      routeType: 1,
      routeTypeName: 'FLOOD',
      hopCount: 1,
      snr: 8.5,
      rssi: -75,
      payloadSize: 32,
      rawHex: '0501020304',
      pathHops: 'direct',
    },
    {
      id: 2,
      sourceId: 'mc-1',
      timestamp: 1725600010000,
      payloadType: 2,
      payloadTypeName: 'TXT_MSG',
      routeType: 1,
      routeTypeName: 'FLOOD',
      hopCount: 2,
      snr: 6.0,
      rssi: -82,
      payloadSize: 48,
      rawHex: '090102030405',
      pathHops: '12->34',
    },
  ];

  beforeEach(() => {
    csrfFetchMock.mockReset();
    hasPermissionImpl = () => true;
    window.URL.createObjectURL = vi.fn(() => 'blob:mock-url');
    window.URL.revokeObjectURL = vi.fn();
  });

  it('renders select-all checkbox and row checkboxes', async () => {
    csrfFetchMock.mockResolvedValue(
      jsonResponse({ packets: mockPackets, enabled: true, maxCount: 1000, maxAgeHours: 24 })
    );

    render(<MeshCorePacketMonitorView baseUrl={baseUrl} sourceId={sourceId} />);

    await waitFor(() => {
      expect(screen.getByText('ADVERT')).toBeTruthy();
    });

    const selectAllCheckbox = screen.getByLabelText('Select all visible packets') as HTMLInputElement;
    expect(selectAllCheckbox).toBeTruthy();
    expect(selectAllCheckbox.checked).toBe(false);

    const rowCheckboxes = screen.getAllByRole('checkbox');
    // 1 select-all checkbox + 2 row checkboxes
    expect(rowCheckboxes.length).toBe(3);
  });

  it('selects all packets when header checkbox is clicked and shows selection bar', async () => {
    csrfFetchMock.mockResolvedValue(
      jsonResponse({ packets: mockPackets, enabled: true, maxCount: 1000, maxAgeHours: 24 })
    );

    render(<MeshCorePacketMonitorView baseUrl={baseUrl} sourceId={sourceId} />);

    await waitFor(() => {
      expect(screen.getByText('ADVERT')).toBeTruthy();
    });

    const selectAllCheckbox = screen.getByLabelText('Select all visible packets') as HTMLInputElement;
    fireEvent.click(selectAllCheckbox);

    expect(selectAllCheckbox.checked).toBe(true);
    expect(screen.getByText('2 packet(s) selected')).toBeTruthy();

    // Deselect all
    fireEvent.click(selectAllCheckbox);
    expect(selectAllCheckbox.checked).toBe(false);
    expect(screen.queryByText('2 packet(s) selected')).toBeNull();
  });

  it('allows individual row selection and exporting selected packets as CSV and JSONL', async () => {
    csrfFetchMock.mockResolvedValue(
      jsonResponse({ packets: mockPackets, enabled: true, maxCount: 1000, maxAgeHours: 24 })
    );

    render(<MeshCorePacketMonitorView baseUrl={baseUrl} sourceId={sourceId} />);

    await waitFor(() => {
      expect(screen.getByText('ADVERT')).toBeTruthy();
    });

    const rowCheckboxes = screen.getAllByRole('checkbox');
    // Click the first row's checkbox
    fireEvent.click(rowCheckboxes[1]);

    expect(screen.getByText('1 packet(s) selected')).toBeTruthy();

    // Export selected JSONL via selection bar
    const jsonlBtn = screen.getByTitle('Export selected packets as JSONL');
    fireEvent.click(jsonlBtn);
    expect(window.URL.createObjectURL).toHaveBeenCalled();

    // Export selected CSV via selection bar
    const csvBtn = screen.getByTitle('Export selected packets as CSV');
    fireEvent.click(csvBtn);
    expect(window.URL.createObjectURL).toHaveBeenCalledTimes(2);

    // Clear selection
    const clearBtn = screen.getByText('Clear selection');
    fireEvent.click(clearBtn);
    expect(screen.queryByText('1 packet(s) selected')).toBeNull();
  });

  it('opens export menu from toolbar and allows exporting all as CSV', async () => {
    csrfFetchMock.mockResolvedValue(
      jsonResponse({ packets: mockPackets, enabled: true, maxCount: 1000, maxAgeHours: 24 })
    );

    render(<MeshCorePacketMonitorView baseUrl={baseUrl} sourceId={sourceId} />);

    await waitFor(() => {
      expect(screen.getByText('ADVERT')).toBeTruthy();
    });

    const exportToolbarBtn = screen.getByLabelText('Export');
    fireEvent.click(exportToolbarBtn);

    const exportAllCsvBtn = screen.getByText('Export All (CSV)');
    fireEvent.click(exportAllCsvBtn);

    expect(window.URL.createObjectURL).toHaveBeenCalled();
  });
});
