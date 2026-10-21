// Records sockets the code under test opens; tests drive them via open()/message()/serverClose().
export class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  binaryType = 'blob';
  sent: any[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: any }) => void) | null = null;
  onerror: ((e: any) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: any) {
    this.sent.push(data);
  }
  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  message(data: any) {
    this.onmessage?.({ data });
  }
  serverClose(code = 1000) {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code });
  }
}
