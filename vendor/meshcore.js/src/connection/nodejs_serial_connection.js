import SerialConnection from "./serial_connection.js";

class NodeJSSerialConnection extends SerialConnection {

    /**
     * @param path serial port to connect to, e.g: "/dev/ttyACM0" or "/dev/cu.usbmodem14401"
     */
    constructor(path) {
        super();
        this.serialPortPath = path;
    }

    async connect() {

        // note: serialport module is only available in NodeJS, you shouldn't use NodeJSSerialConnection from a web browser
        const { SerialPort } = await import('serialport');

        // create new serial port
        this.serialPort = new SerialPort({
            autoOpen: false, // don't auto open, we want to control this manually
            path: this.serialPortPath, // e.g: "/dev/ttyACM0" or "/dev/cu.usbmodem14401"
            baudRate: 115200,
            // Do NOT hold an exclusive advisory lock on the device node. A
            // physical USB unplug can leave a stale fd open at the OS level; with
            // the default lock:true that stale fd keeps holding the lock, so every
            // reconnect on the same path fails with EAGAIN ("Resource temporarily
            // unavailable Cannot lock port") until the process is restarted.
            // lock:false lets a fresh open succeed on the same path after a
            // replug. (MeshMonitor issue #4922.)
            lock: false,
        });

        this.serialPort.on("open", async () => {
           await this.onConnected();
        });

        this.serialPort.on("close", () => {
            this.onDisconnected();
        });

        this.serialPort.on("error", function(err) {
            console.log("SerialPort Error: ", err.message)
        });

        this.serialPort.on("data", async (data) => {
            await this.onDataReceived(data);
        });

        // Open the serial connection and AWAIT the result. serialPort.open() is
        // async; the previous fire-and-forget call let connect() resolve before
        // the port was actually open and swallowed open failures entirely (the
        // caller only found out via a downstream handshake timeout). Await the
        // open callback and reject on failure so callers see a real error
        // immediately. (MeshMonitor issue #4922.)
        await new Promise((resolve, reject) => {
            this.serialPort.open((err) => {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        });

    }

    async close() {
        try {
            await this.serialPort.close();
        } catch(e) {
            console.log("failed to close serial port, ignoring...", e);
        }
    }

    /* override */ async write(bytes) {
        this.serialPort.write(bytes);
    }

}

export default NodeJSSerialConnection;
