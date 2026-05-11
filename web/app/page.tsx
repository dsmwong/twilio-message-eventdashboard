import { MessageList } from "../components/MessageList";
import { SendForm } from "../components/SendForm";

export default function HomePage() {
  return (
    <div className="container stack">
      <header>
        <h1 style={{ margin: 0 }}>Messaging Event Dashboard</h1>
        <p className="muted" style={{ margin: "4px 0 0" }}>
          StatusCallback vs Event Streams, side-by-side.
        </p>
      </header>
      <section className="panel">
        <h2 style={{ marginTop: 0 }}>Send test message</h2>
        <SendForm />
      </section>
      <section className="panel">
        <h2 style={{ marginTop: 0 }}>Recent messages</h2>
        <MessageList />
      </section>
    </div>
  );
}
