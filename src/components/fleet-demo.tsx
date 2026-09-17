"use client";

import { useState } from "react";
import { ArrowRight, CheckCircle2, RotateCcw, Smartphone, CalendarDays } from "lucide-react";
import styles from "./fleet-demo.module.css";

const cities = ["New York", "Los Angeles", "Chicago", "Houston", "Phoenix", "Philadelphia", "San Antonio", "San Diego", "Dallas", "Austin"];
const apps = ["Chrome", "Maps", "Gmail", "Google", "Waze"];
const tasks = Array.from({ length: 250 }, (_, id) => ({ id, phone: id % 50, client: Math.floor((id % 50) / 5), app: apps[(Math.floor(id / 50) + id % 50) % 5] }));
const phases = [
  { name: "Warmup", days: "1–10", quota: "5 tasks per phone daily", detail: "Build a consistent routine across the selected app templates before moving to the next phase." },
  { name: "Money tasks", days: "11–13", quota: "3 tasks per phone daily", detail: "Switch to the client's priority templates on the scheduled day. No need to rebuild 50 separate schedules." },
  { name: "Final squeeze", days: "14–16", quota: "5 tasks per phone daily", detail: "Run the final set of priority templates, with completion tracked separately for every phone." },
  { name: "After action", days: "17–30", quota: "5 tasks per phone daily", detail: "Return to a maintenance routine after the priority window. Each phase follows the previous phase." },
];
function clock(batch: number) {
  const minutes = 480 + batch * 10;
  const day = Math.floor(minutes / 1440);
  return `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}${day ? ` (+${day}d)` : ""}`;
}
function phoneName(phone: number) { return `Phone ${String(phone + 1).padStart(2, "0")}`; }

export function FleetDemo() {
  const [slots, setSlots] = useState(3);
  const [step, setStep] = useState(0);
  const [showFree, setShowFree] = useState(false);
  const [client, setClient] = useState<number | null>(null);
  const [phase, setPhase] = useState(0);
  const batches = Math.ceil(tasks.length / slots);
  const completed = Math.min(step * slots, tasks.length);
  const running = Math.min(slots, tasks.length - completed);
  const start = showFree ? Math.max(step, batches - 1) : step;
  const firstFree = Math.max(step, Math.floor(tasks.length / slots));
  const done = completed === tasks.length;
  const clientDone = (index: number) => tasks.slice(0, completed).filter(task => task.client === index).length;

  return <div className={styles.demo}>
    <header className={styles.header}><strong>StakeoutOps</strong><span>Interactive demo · Sample data</span></header>
    <main className={styles.main}>
      <section className={styles.hero}>
        <div><h1>50 phones. {slots === 3 ? "Three" : slots} slots. One clear plan.</h1><p>See what runs next, spot available time, and keep every client on track.</p></div>
        <div className={styles.actions}><button className={styles.primary} disabled={done} onClick={() => { setStep(Math.min(step + 1, batches)); setShowFree(false); }}>Advance 10 minutes <ArrowRight size={16}/></button><button onClick={() => { setStep(0); setSlots(3); setShowFree(false); setClient(null); setPhase(0); }}><RotateCcw size={15}/> Reset demo</button></div>
      </section>
      <section className={styles.metrics} aria-label="Fleet totals">
        {[["10", "Clients"], ["50", "Dedicated phones"], [String(running), "Running now"], [`${completed} / 250`, "Tasks completed"]].map(([value, label]) => <div key={label}><strong>{value}</strong><span>{label}</span></div>)}
      </section>
      <section className={styles.card} aria-labelledby="calendar-title">
        <div className={styles.cardHeading}><div><h2 id="calendar-title">Your next available slot</h2><p>250 tasks × 10 min · {slots} slots · Finish at {clock(batches)}</p></div><label className={styles.slotLabel}><span className="sr-only">Concurrent phone limit</span><select value={slots} onChange={event => { setSlots(Number(event.target.value)); setStep(0); setShowFree(false); }}>{[1, 3, 5, 10].map(n => <option key={n} value={n}>{n} concurrent {n === 1 ? "phone" : "phones"}</option>)}</select><small>Changing capacity restarts the sample day.</small></label></div>
        <div className={styles.calendarScroll} tabIndex={0} role="region" aria-label="Phone slot calendar, scroll horizontally on small screens">
          <div className={styles.calendar}>
            <div className={styles.lane}><span/><div className={styles.blocks}>{[0, 1, 2, 3].map(n => <span key={n} className={styles.time}>{clock(start + n)}</span>)}</div></div>
            {Array.from({ length: slots }, (_, slot) => <div className={styles.lane} key={slot}><strong>Slot {slot + 1}</strong><div className={styles.blocks}>{[0, 1, 2, 3].map(n => {
              const task = tasks[(start + n) * slots + slot];
              return <div key={n} className={`${styles.block} ${!task ? styles.free : start + n === step ? styles.active : ""}`}>{task ? <><strong>{phoneName(task.phone)} · {task.app}</strong><span>{cities[task.client]} · {start + n === step ? "Running" : "Queued"}</span></> : <><strong>Open slot</strong><span>Available for new work</span></>}</div>;
            })}</div></div>)}
          </div>
        </div>
        <div className={styles.calendarFooter}><div><strong>New work fits at {clock(firstFree)}</strong><span>Simulated time: {clock(step)}{!done && ` · Next phone rotation: ${clock(step + 1)}`}</span></div><div className={styles.actions}><button onClick={() => setShowFree(!showFree)}><CalendarDays size={16}/>{showFree ? "Back to now" : "Find open time"}</button><button disabled={done} onClick={() => { setStep(batches); setShowFree(false); }}>Complete sample day</button></div></div>
        <div className={styles.explainer} role="status" aria-live="polite">{done ? <><CheckCircle2 size={18}/> All 250 sample tasks are complete. All 50 phones are off and every slot is free.</> : <><Smartphone size={18}/> {running} phones on, {50 - running} off. Advance time to finish these tasks and give the next phones their turn.</>}</div>
        <p className={styles.assumption}>Illustrative plan: five tasks per phone, 10 minutes each, starting at 08:00 in one workspace timezone. No boot, retry, or cooldown time is included. Real durations and permitted run windows affect capacity.</p>
      </section>
      <div className={styles.columns}>
        <section className={styles.card} aria-labelledby="clients-title"><h2 id="clients-title">Every client accounted for</h2><p>Five city-dedicated phones per client. Select a client to inspect their phones.</p><div className={styles.clients}>{cities.map((city, index) => <button className={client === index ? styles.selected : ""} aria-pressed={client === index} key={city} onClick={() => setClient(client === index ? null : index)}><span>{city}</span><progress max={25} value={clientDone(index)} aria-label={`${city} tasks complete`}/><strong>{clientDone(index)} / 25</strong></button>)}</div>{client !== null && <div className={styles.phoneDetails}><h3>{cities[client]} · Assigned phones</h3>{Array.from({ length: 5 }, (_, n) => { const phone = client * 5 + n; const finished = tasks.slice(0, completed).filter(t => t.phone === phone).length; const isRunning = tasks.slice(completed, completed + running).some(t => t.phone === phone); return <div key={phone}><span>{phoneName(phone)}</span><span>{finished}/5 complete · {isRunning ? "On · Running" : "Off"}</span></div>; })}</div>}</section>
        <section className={styles.card} aria-labelledby="phases-title"><h2 id="phases-title">Four phases, one reusable plan</h2><p>An example 30-day program. Select a phase to explore its daily workload.</p><div className={styles.phases}>{phases.map((item, index) => <button className={phase === index ? styles.selected : ""} aria-pressed={phase === index} key={item.name} onClick={() => setPhase(index)}><span className={styles.phaseNumber}>{index + 1}</span><strong>{item.name}</strong><span>Days {item.days}</span></button>)}</div><div className={styles.phaseDetail}><strong>{phases[phase].quota}</strong><p>{phases[phase].detail}</p><small>Phase preview only; the calendar above keeps its 250-task sample workload.</small></div><div className={styles.benefit}><CheckCircle2 size={18}/><p><strong>One view of the whole operation.</strong><br/>Know what is complete, what is queued, and when there is room for more—before switching phones manually.</p></div></section>
      </div>
      <footer className={styles.footer}>Simulation only. No devices are connected. Changes stay in this browser session and reset on refresh.<br/><a href="https://scheduler-dashboard-production.up.railway.app">Open your live scheduler <ArrowRight size={13}/></a></footer>
    </main>
  </div>;
}
