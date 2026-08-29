# MeshCore Node Setup & Configuration

This guide provides a comprehensive walkthrough for setting up, connecting, and configuring **MeshCore** nodes with MeshMonitor.

MeshCore is an alternative open-source LoRa mesh networking protocol that runs on much of the same hardware as Meshtastic (ESP32, nRF52, Heltec, RAK, LilyGO, etc.). In MeshMonitor, MeshCore devices are supported as first-class sources with dedicated telemetry, mapping, messaging, remote administration, and automation capabilities.

---

## 1. Device Roles & Hardware

MeshCore devices operate in one of three primary firmware roles:

| Role | Device Code | Description | Supported Transports |
|---|---|---|---|
| **Companion** | `advType=1` | Full-featured node meant to pair with an app or dashboard. Exposes binary protocol commands for identity, channels, telemetry, and settings. | USB Serial, Native TCP |
| **Repeater** | `advType=2` | Infrastructure node that relays flood traffic and maintains neighbor tables. Exposes a text-based CLI over USB serial or Remote Admin DM. | USB Serial (Direct), Remote Admin over RF |
| **Room Server** | `advType=3` | BBS-style message board server that stores and push-syncs posts across channels and DMs. | USB Serial, Native TCP |

---

## 2. Connecting a MeshCore Node to MeshMonitor

MeshCore sources are added directly through the MeshMonitor UI in the **Sources sidebar** (Dashboard → `+ Add Source`). They hot-connect immediately without requiring a container restart.

### A. USB / Serial Connection (Linux & Raspberry Pi)

Connect your MeshCore device (Companion, Repeater, or Room Server) via USB to the host running MeshMonitor.

1. **Identify the Serial Port**:
   On Linux / Raspberry Pi / Docker hosts:
   ```bash
   ls /dev/ttyACM* /dev/ttyUSB*
   ```
2. **Container Device Mapping (Docker Compose)**:
   If running MeshMonitor in Docker, pass the serial device into the container in your `docker-compose.yml`:
   ```yaml
   services:
     meshmonitor:
       image: ghcr.io/yeraze/meshmonitor:latest
       container_name: meshmonitor
       ports:
         - "8080:3001"
       devices:
         - "/dev/ttyACM0:/dev/ttyACM0"   # Map host serial port
       volumes:
         - meshmonitor-data:/data
       restart: unless-stopped
   ```
   > [!TIP]
   > MeshMonitor automatically grants permissions to mapped tty groups on container startup.

3. **Add the Source in MeshMonitor UI**:
   - Open **Dashboard** → **Sources sidebar** (click `+`).
   - Select **MeshCore** as the source type.
   - Choose Transport: **USB**.
   - Enter Serial Port: e.g., `/dev/ttyACM0`.
   - Select Device Type: **Companion** or **Repeater**.
   - Enable **Auto-connect** and click **Save**.

---

### B. USB / Serial Connection on Windows (Docker Desktop & WSL2)

Running Docker Desktop on Windows requires mapping a Windows USB serial port (e.g., `COM3`, `COM4`) into the Docker environment. There are two primary methods for Windows:

#### Method 1: USB Passthrough to WSL2 with `usbipd-win` (Recommended for direct serial mapping)

1. **Install `usbipd-win`**:
   Download and install the latest release from [usbipd-win releases](https://github.com/dorssel/usbipd-win/releases).

2. **Identify Your USB Serial Device**:
   Open Windows PowerShell as **Administrator** and run:
   ```powershell
   usbipd list
   ```
   Example output:
   ```
   BUSID  DEVICE                                      STATE
   1-8    CP210x USB to UART Bridge (COM3)           Not shared
   ```
   Note the `BUSID` (e.g., `1-8`).

3. **Bind and Attach the Device to WSL2**:
   In PowerShell (Administrator):
   ```powershell
   usbipd bind --busid 1-8
   usbipd attach --wsl --busid 1-8
   ```

4. **Verify in Docker / WSL2**:
   Inside your WSL2 terminal or Docker host environment, check for the serial device:
   ```bash
   ls /dev/ttyUSB* /dev/ttyACM*
   ```
   The device will appear as `/dev/ttyUSB0` or `/dev/ttyACM0`.

5. **Configure `docker-compose.yml`**:
   ```yaml
   services:
     meshmonitor:
       image: ghcr.io/yeraze/meshmonitor:latest
       container_name: meshmonitor
       ports:
         - "8080:3001"
       devices:
         - "/dev/ttyUSB0:/dev/ttyUSB0"
       volumes:
         - meshmonitor-data:/data
       restart: unless-stopped
   ```

6. **Add Source in UI**:
   In MeshMonitor UI: Add Source → **MeshCore** → Transport **USB** → Serial Port: `/dev/ttyUSB0` → Device Type: **Companion** or **Repeater**.

---

#### Method 2: Serial-to-TCP Bridge on Windows (No `usbipd-win` required)

If you prefer not to use `usbipd-win`, you can bridge your Windows `COM` port to a local TCP port and connect MeshMonitor over TCP.

1. **Start a Python TCP Serial Bridge on Windows**:
   In Windows Command Prompt or PowerShell:
   ```cmd
   python -m serial.tools.tcp_serial_redirect -P 4403 COM3 115200
   ```
   *(Replaces `COM3` with your device's COM port)*.

2. **Add TCP Source in MeshMonitor UI**:
   - Open **Dashboard** → **Sources sidebar** (click `+`).
   - Select **MeshCore**.
   - Choose Transport: **TCP**.
   - Enter Host: `host.docker.internal` (resolves to host Windows machine from inside Docker).
   - Enter Port: `4403`.
   - Select Device Type: **Companion**.
   - Click **Save**.

---

### C. TCP Network Connection (Windows, Linux, & macOS)

MeshCore Companions and Room Servers reachable over WiFi/Ethernet or network proxies (`ser2net`, `esp-link`, or native TCP firmware) connect over TCP.

#### Add TCP Source in UI:
1. Open **Dashboard** → **Sources sidebar** (click `+`).
2. Select **MeshCore**.
3. Choose Transport: **TCP**.
4. Enter Host IP/Domain:
   - **On Linux/macOS**: LAN IP of device (e.g. `192.168.1.150`).
   - **On Docker Desktop for Windows**: Use `host.docker.internal` if the proxy runs on the Windows host, or the device's LAN IP if attached to your local network.
5. Enter Port: `4403` (or your custom bridged port).
6. Select Device Type: **Companion**.
7. Enable **Auto-connect** and click **Save**.

> [!WARNING] Container Networking on Windows
> Do not use `127.0.0.1` or `localhost` as the TCP host in Docker settings on Windows, as `localhost` inside the container refers to the container itself. Use `host.docker.internal` or your Windows machine's LAN IP address.

---

### D. Heartbeat & Auto-Reconnect

When adding or editing a Companion source, you can specify a **Heartbeat Interval** in seconds (e.g., `30` seconds, `0` = off). MeshMonitor will periodically query the companion device health and automatically reconnect with exponential backoff if the physical or TCP link drops.

---

## 3. Configuring MeshCore Nodes in MeshMonitor

Once connected, click your MeshCore source in the sidebar to open the **MeshCore Page**. Select the **Configuration** tab in the sub-toolbar to configure the node.

### A. Identity Configuration

- **Device Name**: Set the node's display name (`set name`).
- **Owner Name**: Set the operator/user name attached to the node.

Click **Save Identity** to update the local hardware node.

---

### B. Radio Parameters & Preset Selector

MeshCore nodes must be configured with matching radio parameters to communicate over the mesh.

#### Using Presets
MeshMonitor includes an official **Radio Preset** selector dropdown (e.g., EU868, US915 regional presets). Selecting a preset automatically populates:
- **Frequency (MHz)**: e.g., `869.525` MHz
- **Bandwidth (kHz)**: `125`, `250`, or `500` kHz
- **Spreading Factor (SF)**: `SF5` through `SF12`
- **Coding Rate (CR)**: `4/5` through `4/8`

#### Custom Radio Tuning
Select **Custom** in the preset dropdown to manually edit Frequency, Bandwidth, Spreading Factor, and Coding Rate.

#### TX Power Limit
Adjust the transmission output power (in dBm) up to the device hardware's `maxTxPower` (e.g. `22` dBm).

> [!CAUTION] Radio Mismatches
> Changing radio parameters will disconnect your node from any peers operating on different frequencies or modulation settings. Ensure all nodes in your mesh share identical radio parameters.

---

### C. Location & Advert Policy

- **Manual Coordinates**: Set fixed **Latitude**, **Longitude**, and **Altitude** for nodes without a hardware GPS module.
- **Advert Location Policy**:
  - **Include Position (Enabled)**: Node includes GPS/fixed coordinates in periodic node adverts broadcast over the air.
  - **Hide Position (Disabled)**: Coordinates are omitted from public node adverts.

Click **Save Location** or **Save Policy** to apply.

---

### D. Telemetry & Sensor Modes

MeshMonitor supports both local companion polling and over-the-air node telemetry emission:

#### Telemetry Modes (Device Emission over RF)
Toggle how the local node emits telemetry to the mesh:
- **Base Telemetry**: Battery percentage, voltage, and uptime. Options: `always`, `device`, `never`.
- **Location Telemetry**: GPS coordinates and fix quality. Options: `always`, `device`, `never`.
- **Environment Telemetry**: Temperature, humidity, pressure sensors (Cayenne LPP). Options: `always`, `device`, `never`.

#### Per-Node Remote Telemetry Sync
You can configure MeshMonitor to periodically pull remote telemetry from other MeshCore nodes on the mesh:
1. Go to **MeshCore Page** → **Node Details**.
2. Select a target contact.
3. Open the **Contact Detail Panel**.
4. Enable **Remote Telemetry** and specify an interval (in minutes).
5. Click **Save**.

MeshMonitor will periodically issue `req_telemetry_sync` commands, decode Cayenne-LPP telemetry responses, and store data into the shared telemetry database.

> [!NOTE] 60-Second RF Rate Limiter
> Scheduled and on-demand mesh requests are rate-limited with a mandatory 60-second cooldown per source to prevent airtime exhaustion.

---

### E. Region / Scope Routing Setup

Some MeshCore repeaters employ strict region filtering (e.g., `region denyf *`) and will drop any un-scoped flood packets. MeshMonitor provides complete region/scope configuration:

1. **Per-Channel Scope**: Assign a scope name (e.g., `germany` or `muenchen`) to individual channels in **Configuration** → **Channels**.
2. **Default Source Scope**: Set a fallback default scope in **MeshCore Settings**.
3. **Discover Regions**: In **Settings**, click **Discover Regions** to run a zero-hop query against nearby repeaters to discover active regional tags.
4. **Saved Regions Catalog**: Store frequently used scope tags in your global catalog for easy selection in message overrides.

---

### F. Channels & Encryption Keys

Manage channels under **Configuration** → **Channels**:
- **Add / Edit Channel**: Specify Channel Name, Role, PSK key, and Region Scope.
- **Channel PSK**: Channels use standard AES encryption keys for secure group messaging.

---

## 4. Remote Administration & Repeater Management

MeshCore repeaters (`advType=2`) and room servers (`advType=3`) can be administered remotely over the air via encrypted text CLI commands.

### Accessing Remote Console
1. Navigate to **Node Details** and select a Repeater or Room Server contact.
2. Open the **Remote Administration** section in the contact panel.
3. Enter the node's **Admin Password** (or leave blank for guest access).
4. Tick **Remember this password** to securely save the password.

### Encrypted Credential Store
When password persistence is enabled, credentials are encrypted server-side using **AES-256-GCM** backed by your `SESSION_SECRET` environment variable.

> [!IMPORTANT] SESSION_SECRET Required
> To enable saved remote admin passwords, set `SESSION_SECRET` in your environment:
> ```yaml
> environment:
>   - SESSION_SECRET=a_very_long_and_secure_random_string_here
> ```

### ACL Permission Management
Set node access control levels (`setperm`) directly from the remote admin console:
- Paste a user's 64-character public key hex string.
- Select permission level: **Remove**, **Guest**, **ReadWrite**, or **Admin**.
- Click **Apply**.

### Danger Commands Gating
Destructive commands (`reboot`, `erase`, `factory`) require typed name confirmation in the UI and are enforced server-side.

---

## 5. MeshCore Virtual Node Server on Windows

MeshMonitor includes an embedded **MeshCore Virtual Node Server** that acts as a proxy node listening on TCP port `5000`. This allows third-party tools, companion mobile apps, or ATAK bridges to communicate through your MeshMonitor instance.

### Enabling Virtual Node
The Virtual Node server compiles and starts automatically when MeshMonitor is running.

- **Main Listening Port**: `5000` (TCP binary protocol proxy).
- **Serial Emulation Ports**: `4503`–`4505`.
- **CLI Console Port**: `4404`–`4405`.

### Windows Defender Firewall Setup
When running Docker Desktop on Windows, configure Windows Defender Firewall to allow inbound connections on port `5000` (and `8080` for web UI access):
1. Open **Windows Defender Firewall with Advanced Security**.
2. Click **Inbound Rules** → **New Rule**.
3. Rule Type: **Port** → TCP → Specific local ports: `5000, 8080`.
4. Action: **Allow the connection**.

### PKI Private Key Export Gate
Tools authenticating as the node itself (such as ATAK CoT bridges or Remote Terminal) may issue `ExportPrivateKey(23)` requests.

By default, PKI key export over the Virtual Node is **disabled** for security. To enable key export:
1. Go to **Settings** → **MeshCore Virtual Node**.
2. Toggle **Allow PKI export** (`virtualNode.allowPkiExport`) to ON.
3. Every export attempt is recorded in the system audit log.

---

## 6. Environment Variables Reference

Key environment variables for tuning MeshCore operations:

| Variable | Default | Description |
|---|---|---|
| `MESHCORE_TELEMETRY_INTERVAL_MS` | `300000` (5 min) | How often (ms) MeshMonitor polls the local connected companion for stats. |
| `MESHCORE_REMOTE_TELEMETRY_TICK_MS` | `3000` (30 sec) | Interval (ms) for walking nodes scheduled for remote telemetry sync. |
| `SESSION_SECRET` | *(auto-generated)* | Key used for AES-256-GCM encryption of saved remote admin & room server passwords. |

---

## 7. Windows Troubleshooting Checklist

### USB Serial Device Not Found on Windows Docker
- If using `usbipd-win`, confirm the device is attached: `usbipd list` should show `Attached` to WSL.
- If using WSL2, ensure `usbipd attach --wsl --busid <busid>` was executed after plugging in the USB cable.
- If using Serial-to-TCP bridge, verify Python or `com2tcp` process is active on Windows port `4403`.

### Container Connection Timeout on `host.docker.internal`
- Verify `host.docker.internal` resolves inside the container.
- Check Windows Defender Firewall rules for port `4403` or `3001`/`8080`.

### Remote Admin Login Refused
- Confirm the target node is running firmware with remote admin enabled.
- Verify that your node's public key has `ReadWrite` or `Admin` ACL permissions on the repeater.
