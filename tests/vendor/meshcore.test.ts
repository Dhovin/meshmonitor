import { describe, it, expect } from 'vitest';
import {
  Connection,
  Constants,
  CommandCodes,
  ResponseCodes,
  PushCodes,
} from '@liamcottle/meshcore.js';
import BufferReader from '../../vendor/meshcore.js/src/buffer_reader.js';
import BufferWriter from '../../vendor/meshcore.js/src/buffer_writer.js';
import {
  encodeRepeaterStatusData,
  encodeStatusResponsePush,
} from '../../src/server/meshcoreCompanionCodec';

class MockConnection extends Connection {
  public sentFrames: Uint8Array[] = [];

  async sendToRadioFrame(bytes: Uint8Array): Promise<void> {
    this.sentFrames.push(bytes);
  }
}

function writeInt8(writer: any, n: number): void {
  writer.writeByte(n < 0 ? n + 256 : n);
}

function writeInt16LE(writer: any, n: number): void {
  writer.writeUInt16LE(n < 0 ? n + 65536 : n);
}

describe('Vendored meshcore.js Bug Fixes & Protocol Enhancements', () => {
  describe('Constants & Exports', () => {
    it('exports new command and response codes from constants', () => {
      expect(Constants.CommandCodes.SetPathHashMode).toBe(61);
      expect(CommandCodes.SetPathHashMode).toBe(61);

      expect(Constants.ResponseCodes.ContactMsgRecvV3).toBe(16);
      expect(ResponseCodes.ContactMsgRecvV3).toBe(16);

      expect(Constants.ResponseCodes.ChannelMsgRecvV3).toBe(17);
      expect(ResponseCodes.ChannelMsgRecvV3).toBe(17);

      expect(Constants.PushCodes.LoginFail).toBe(0x86);
      expect(PushCodes.LoginFail).toBe(0x86);
    });
  });

  describe('BufferReader.readString null byte handling (PR #33 / Issue #28)', () => {
    it('truncates at embedded NUL byte when present', () => {
      const encoder = new TextEncoder();
      const stringBytes = encoder.encode('Heltec V3');
      const trailingBytes = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
      const combined = new Uint8Array(stringBytes.length + trailingBytes.length);
      combined.set(stringBytes, 0);
      combined.set(trailingBytes, stringBytes.length);

      const reader = new BufferReader(combined);
      expect(reader.readString()).toBe('Heltec V3');
    });

    it('decodes full remainder if no NUL byte is present', () => {
      const encoder = new TextEncoder();
      const bytes = encoder.encode('PlainMessageWithoutNull');
      const reader = new BufferReader(bytes);
      expect(reader.readString()).toBe('PlainMessageWithoutNull');
    });
  });

  describe('Core Stats offset parsing (Issue #36 / PR #37)', () => {
    it('correctly parses batteryMilliVolts, uptimeSecs, errors, and queueLen without offset shift', async () => {
      const conn = new MockConnection();

      // Payload for STATS_TYPE_CORE:
      // [type: uint8 (1)]
      // [battery_mv: uint16 LE (4150 -> 0x1036)]
      // [uptime_secs: uint32 LE (86400 -> 0x00015180)]
      // [errors: uint16 LE (0x0201 -> 513)]
      // [queue_len: uint8 (7)]
      const writer = new BufferWriter();
      writer.writeByte(Constants.ResponseCodes.Stats); // 24
      writer.writeByte(Constants.StatsTypes.Core); // 1
      writer.writeUInt16LE(4150);
      writer.writeUInt32LE(86400);
      writer.writeUInt16LE(0x0201); // errors = 513
      writer.writeByte(7); // queueLen = 7

      const statsPromise = new Promise<any>((resolve) => {
        conn.once(Constants.ResponseCodes.Stats, (res) => resolve(res.data));
      });

      conn.onFrameReceived(writer.toBytes());

      const data = await statsPromise;
      expect(data.batteryMilliVolts).toBe(4150);
      expect(data.uptimeSecs).toBe(86400);
      expect(data.errors).toBe(513);
      expect(data.queueLen).toBe(7);
    });
  });

  describe('getStatus RepeaterStats decoding (Issue #36 / PR #37)', () => {
    function buildRepeaterStatsBuffer(includeNewFields: boolean): Uint8Array {
      const writer = new BufferWriter();
      writer.writeUInt16LE(4120); // batt_milli_volts
      writer.writeUInt16LE(2); // curr_tx_queue_len
      writeInt16LE(writer, -115); // noise_floor
      writeInt16LE(writer, -75); // last_rssi
      writer.writeUInt32LE(100); // n_packets_recv
      writer.writeUInt32LE(80); // n_packets_sent
      writer.writeUInt32LE(3600); // total_air_time_secs
      writer.writeUInt32LE(7200); // total_up_time_secs
      writer.writeUInt32LE(50); // n_sent_flood
      writer.writeUInt32LE(30); // n_sent_direct
      writer.writeUInt32LE(70); // n_recv_flood
      writer.writeUInt32LE(30); // n_recv_direct
      writer.writeUInt16LE(0); // err_events
      writeInt16LE(writer, 36); // last_snr (9.0 * 4)
      writer.writeUInt16LE(5); // n_direct_dups
      writer.writeUInt16LE(12); // n_flood_dups (byte 46-47)

      if (includeNewFields) {
        writer.writeUInt32LE(1234); // total_rx_air_time_secs (bytes 48-51)
        writer.writeUInt32LE(15); // n_recv_errors (bytes 52-55)
      }

      return writer.toBytes();
    }

    it('decodes legacy 48-byte RepeaterStats with null for new fields', async () => {
      const conn = new MockConnection();
      const pubKey = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
      const statusPromise = conn.getStatus(pubKey);

      // Node responds with Sent frame
      const sentWriter = new BufferWriter();
      sentWriter.writeByte(Constants.ResponseCodes.Sent);
      sentWriter.writeByte(0); // result OK
      sentWriter.writeUInt32LE(0x1234); // ack crc
      sentWriter.writeUInt32LE(500); // est timeout
      conn.onFrameReceived(sentWriter.toBytes());

      // Node pushes StatusResponse with 48 bytes statusData
      const pushWriter = new BufferWriter();
      pushWriter.writeByte(Constants.PushCodes.StatusResponse);
      pushWriter.writeByte(0); // reserved
      pushWriter.writeBytes([1, 2, 3, 4, 5, 6]); // pubKeyPrefix matching
      pushWriter.writeBytes(buildRepeaterStatsBuffer(false));
      conn.onFrameReceived(pushWriter.toBytes());

      const result = await statusPromise;
      expect(result.batt_milli_volts).toBe(4120);
      expect(result.n_flood_dups).toBe(12);
      expect(result.total_rx_air_time_secs).toBeNull();
      expect(result.n_recv_errors).toBeNull();
    });

    it('decodes modern 56-byte RepeaterStats including total_rx_air_time_secs and n_recv_errors', async () => {
      const conn = new MockConnection();
      const pubKey = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
      const statusPromise = conn.getStatus(pubKey);

      // Node responds with Sent frame
      const sentWriter = new BufferWriter();
      sentWriter.writeByte(Constants.ResponseCodes.Sent);
      sentWriter.writeByte(0);
      sentWriter.writeUInt32LE(0x1234);
      sentWriter.writeUInt32LE(500);
      conn.onFrameReceived(sentWriter.toBytes());

      // Node pushes StatusResponse with 56 bytes statusData
      const pushWriter = new BufferWriter();
      pushWriter.writeByte(Constants.PushCodes.StatusResponse);
      pushWriter.writeByte(0);
      pushWriter.writeBytes([1, 2, 3, 4, 5, 6]);
      pushWriter.writeBytes(buildRepeaterStatsBuffer(true));
      conn.onFrameReceived(pushWriter.toBytes());

      const result = await statusPromise;
      expect(result.batt_milli_volts).toBe(4120);
      expect(result.n_flood_dups).toBe(12);
      expect(result.total_rx_air_time_secs).toBe(1234);
      expect(result.n_recv_errors).toBe(15);
    });
  });

  describe('DeviceInfo v3+/v10+ layout (Issue #28 / PR #31)', () => {
    it('parses extended DeviceInfo fields (manufacturerModel, firmwareVersion, clientRepeat, pathHashMode)', async () => {
      const conn = new MockConnection();

      const writer = new BufferWriter();
      writer.writeByte(Constants.ResponseCodes.DeviceInfo); // 13
      writer.writeByte(10); // firmwareVer
      writer.writeBytes(new Uint8Array(6)); // reserved (max contacts/channels)
      writer.writeCString('2026-06-25', 12); // firmware_build_date (12 bytes)
      writer.writeCString('Heltec T114', 40); // manufacturerModel (fixed 40 bytes)
      writer.writeCString('v1.14.2', 20); // firmwareVersion (20 bytes)
      writer.writeByte(1); // clientRepeat
      writer.writeByte(2); // pathHashMode

      const infoPromise = new Promise<any>((resolve) => {
        conn.once(Constants.ResponseCodes.DeviceInfo, (info) => resolve(info));
      });

      conn.onFrameReceived(writer.toBytes());

      const info = await infoPromise;
      expect(info.firmwareVer).toBe(10);
      expect(info.firmware_build_date).toBe('2026-06-25');
      expect(info.manufacturerModel).toBe('Heltec T114');
      expect(info.firmwareVersion).toBe('v1.14.2');
      expect(info.clientRepeat).toBe(1);
      expect(info.pathHashMode).toBe(2);
    });

    it('handles legacy DeviceInfo payloads gracefully when optional tail is absent', async () => {
      const conn = new MockConnection();

      const writer = new BufferWriter();
      writer.writeByte(Constants.ResponseCodes.DeviceInfo);
      writer.writeByte(2);
      writer.writeBytes(new Uint8Array(6));
      writer.writeCString('2024-01-01', 12);
      writer.writeCString('Legacy Node', 40);

      const infoPromise = new Promise<any>((resolve) => {
        conn.once(Constants.ResponseCodes.DeviceInfo, (info) => resolve(info));
      });

      conn.onFrameReceived(writer.toBytes());

      const info = await infoPromise;
      expect(info.firmwareVer).toBe(2);
      expect(info.manufacturerModel).toBe('Legacy Node');
      expect(info.firmwareVersion).toBeNull();
      expect(info.clientRepeat).toBeNull();
      expect(info.pathHashMode).toBeNull();
    });
  });

  describe('TraceData multibyte path hashes and SNR count (Issue #28 / PR #30)', () => {
    it('decodes 2-byte path hashes with SNR count = pathLen >> path_sz', async () => {
      const conn = new MockConnection();

      // 5 hops in 2-byte mode:
      // pathLen = 10 (bytes on the wire)
      // flags = 1 (path_sz = 1 -> 2 bytes per hop)
      // snrCount = 10 >> 1 = 5 hop SNRs
      // snrBytes length = 5 + 1 = 6 (5 hop SNRs + 1 last SNR)
      const writer = new BufferWriter();
      writer.writeByte(Constants.PushCodes.TraceData); // 0x89
      writer.writeByte(0); // reserved
      writer.writeByte(10); // pathLen = 10
      writer.writeByte(1); // flags = 1 (path_sz = 1)
      writer.writeUInt32LE(0x11223344); // tag
      writer.writeUInt32LE(0x55667788); // authCode

      // 10 path hash bytes
      writer.writeBytes([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

      // 5 hop SNRs + 1 destination SNR
      // SNRs: [-8, -4, 0, 4, 8, 12] -> stored as raw int8 * 4: [-32, -16, 0, 16, 32, 48]
      writer.writeBytes([224, 240, 0, 16, 32, 48]);

      const tracePromise = new Promise<any>((resolve) => {
        conn.once(Constants.PushCodes.TraceData, (data) => resolve(data));
      });

      conn.onFrameReceived(writer.toBytes());

      const data = await tracePromise;
      expect(data.pathLen).toBe(10);
      expect(data.flags).toBe(1);
      expect(data.tag).toBe(0x11223344);
      expect(data.authCode).toBe(0x55667788);
      expect(Array.from(data.pathHashes)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(data.pathSnrs.length).toBe(5);
      expect(data.lastSnr).toBe(48 / 4); // 12
    });
  });

  describe('V3 Message Frames with SNR (PR #35)', () => {
    it('decodes ContactMsgRecvV3 (16) and emits ContactMsgRecv with snr', async () => {
      const conn = new MockConnection();

      // Wire layout for ContactMsgRecvV3 (16):
      // [code: 16]
      // [snr: int8 (-28 -> -7.0 dB)]
      // [reserved: 2 bytes]
      // [pubKeyPrefix: 6 bytes]
      // [pathLen: uint8]
      // [txtType: uint8]
      // [senderTimestamp: uint32LE]
      // [text: remainder]
      const writer = new BufferWriter();
      writer.writeByte(Constants.ResponseCodes.ContactMsgRecvV3); // 16
      writeInt8(writer, -28); // -7 dB (since -28 / 4 = -7.0)
      writer.writeBytes([0, 0]); // 2 reserved bytes
      writer.writeBytes([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]); // pubKeyPrefix
      writer.writeByte(3); // pathLen
      writer.writeByte(0); // txtType = Plain
      writer.writeUInt32LE(1700000000); // timestamp
      writer.writeString('Hello V3 Contact!');

      const msgPromise = new Promise<any>((resolve) => {
        conn.once(Constants.ResponseCodes.ContactMsgRecv, (msg) => resolve(msg));
      });

      conn.onFrameReceived(writer.toBytes());

      const msg = await msgPromise;
      expect(msg.snr).toBe(-7.0);
      expect(msg.text).toBe('Hello V3 Contact!');
      expect(msg.pathLen).toBe(3);
      expect(msg.senderTimestamp).toBe(1700000000);
    });

    it('decodes ChannelMsgRecvV3 (17) and emits ChannelMsgRecv with snr', async () => {
      const conn = new MockConnection();

      // Wire layout for ChannelMsgRecvV3 (17):
      // [code: 17]
      // [snr: int8 (40 -> 10.0 dB)]
      // [reserved: 2 bytes]
      // [channelIdx: int8]
      // [pathLen: uint8]
      // [txtType: uint8]
      // [senderTimestamp: uint32LE]
      // [text: remainder]
      const writer = new BufferWriter();
      writer.writeByte(Constants.ResponseCodes.ChannelMsgRecvV3); // 17
      writeInt8(writer, 40); // 10.0 dB (40 / 4)
      writer.writeBytes([0, 0]); // reserved
      writer.writeByte(0); // channelIdx (public)
      writer.writeByte(2); // pathLen
      writer.writeByte(0); // txtType
      writer.writeUInt32LE(1700000050);
      writer.writeString('General: Broadcast message');

      const msgPromise = new Promise<any>((resolve) => {
        conn.once(Constants.ResponseCodes.ChannelMsgRecv, (msg) => resolve(msg));
      });

      conn.onFrameReceived(writer.toBytes());

      const msg = await msgPromise;
      expect(msg.snr).toBe(10.0);
      expect(msg.channelIdx).toBe(0);
      expect(msg.text).toBe('General: Broadcast message');
    });

    it('emits snr: null for legacy V1 Contact and Channel message frames', async () => {
      const conn = new MockConnection();

      const contactWriter = new BufferWriter();
      contactWriter.writeByte(Constants.ResponseCodes.ContactMsgRecv); // 7
      contactWriter.writeBytes([1, 2, 3, 4, 5, 6]);
      contactWriter.writeByte(1);
      contactWriter.writeByte(0);
      contactWriter.writeUInt32LE(1700000000);
      contactWriter.writeString('Legacy Contact Msg');

      const contactPromise = new Promise<any>((resolve) => {
        conn.once(Constants.ResponseCodes.ContactMsgRecv, (msg) => resolve(msg));
      });
      conn.onFrameReceived(contactWriter.toBytes());

      const contactMsg = await contactPromise;
      expect(contactMsg.snr).toBeNull();
      expect(contactMsg.text).toBe('Legacy Contact Msg');
    });
  });

  describe('LoginFail push dispatch (PR #32)', () => {
    it('dispatches LoginFail event with reserved byte and pubKeyPrefix', async () => {
      const conn = new MockConnection();

      const writer = new BufferWriter();
      writer.writeByte(Constants.PushCodes.LoginFail); // 0x86
      writer.writeByte(0); // reserved
      writer.writeBytes([11, 22, 33, 44, 55, 66]); // pubKeyPrefix

      const failPromise = new Promise<any>((resolve) => {
        conn.once(Constants.PushCodes.LoginFail, (data) => resolve(data));
      });

      conn.onFrameReceived(writer.toBytes());

      const data = await failPromise;
      expect(data.reserved).toBe(0);
      expect(Array.from(data.pubKeyPrefix)).toEqual([11, 22, 33, 44, 55, 66]);
    });
  });

  describe('SetPathHashMode command sending (PR #31)', () => {
    it('sends CMD_SET_PATH_HASH_MODE (61) frame and resolves on Ok', async () => {
      const conn = new MockConnection();

      const setPromise = conn.setPathHashMode(2);

      // Verify the frame sent to radio
      expect(conn.sentFrames.length).toBe(1);
      expect(Array.from(conn.sentFrames[0])).toEqual([61, 0, 2]);

      // Respond with Ok (0)
      const okWriter = new BufferWriter();
      okWriter.writeByte(Constants.ResponseCodes.Ok);
      conn.onFrameReceived(okWriter.toBytes());

      await expect(setPromise).resolves.toBeUndefined();
    });
  });

  describe('Companion Codec Repeater Status & meshcore.js getStatus roundtrip', () => {
    it('encodes 48-byte legacy repeater status when rxAirTime and recvErrors are not set', () => {
      const buffer = encodeRepeaterStatusData({
        batteryMv: 4120,
        queueLen: 3,
        noiseFloor: -110,
        lastRssi: -72,
        packetsRecv: 120,
        packetsSent: 90,
        airTimeSecs: 3600,
        uptimeSecs: 7200,
        sentFlood: 60,
        sentDirect: 30,
        recvFlood: 80,
        recvDirect: 40,
        errors: 1,
        lastSnr: 32,
        directDups: 4,
        floodDups: 10,
      });

      expect(buffer.length).toBe(48);
    });

    it('encodes 56-byte extended repeater status when totalRxAirTimeSecs and recvErrors are set', () => {
      const buffer = encodeRepeaterStatusData({
        batteryMv: 4120,
        queueLen: 3,
        noiseFloor: -110,
        lastRssi: -72,
        packetsRecv: 120,
        packetsSent: 90,
        airTimeSecs: 3600,
        uptimeSecs: 7200,
        sentFlood: 60,
        sentDirect: 30,
        recvFlood: 80,
        recvDirect: 40,
        errors: 1,
        lastSnr: 32,
        directDups: 4,
        floodDups: 10,
        totalRxAirTimeSecs: 500,
        recvErrors: 8,
      });

      expect(buffer.length).toBe(56);
      expect(buffer.readUInt32LE(48)).toBe(500); // total_rx_air_time_secs
      expect(buffer.readUInt32LE(52)).toBe(8); // n_recv_errors
    });

    it('successfully roundtrips encodeStatusResponsePush (56 bytes) to meshcore.js getStatus', async () => {
      const conn = new MockConnection();
      const pubKey = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);
      const statusPromise = conn.getStatus(pubKey);

      // Sent frame
      const sentWriter = new BufferWriter();
      sentWriter.writeByte(Constants.ResponseCodes.Sent);
      sentWriter.writeByte(0);
      sentWriter.writeUInt32LE(0x5678);
      sentWriter.writeUInt32LE(1000);
      conn.onFrameReceived(sentWriter.toBytes());

      // Push frame generated via encodeStatusResponsePush
      const pushBuffer = encodeStatusResponsePush(pubKey.subarray(0, 6), {
        batteryMv: 4200,
        queueLen: 1,
        noiseFloor: -105,
        lastRssi: -65,
        packetsRecv: 250,
        packetsSent: 180,
        airTimeSecs: 4500,
        uptimeSecs: 86400,
        sentFlood: 100,
        sentDirect: 80,
        recvFlood: 150,
        recvDirect: 100,
        errors: 2,
        lastSnr: 40,
        directDups: 7,
        floodDups: 15,
        rxAirTimeSecs: 750,
        recvErrors: 12,
      });

      conn.onFrameReceived(new Uint8Array(pushBuffer));

      const decoded = await statusPromise;
      expect(decoded.batt_milli_volts).toBe(4200);
      expect(decoded.curr_tx_queue_len).toBe(1);
      expect(decoded.n_packets_recv).toBe(250);
      expect(decoded.n_packets_sent).toBe(180);
      expect(decoded.total_air_time_secs).toBe(4500);
      expect(decoded.total_up_time_secs).toBe(86400);
      expect(decoded.total_rx_air_time_secs).toBe(750);
      expect(decoded.n_recv_errors).toBe(12);
    });
  });
});
