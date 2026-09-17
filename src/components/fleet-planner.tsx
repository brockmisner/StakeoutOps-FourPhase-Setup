"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowUpRight, CalendarDays, Check, ChevronLeft, ChevronRight, Clock3, RefreshCw, SlidersHorizontal, Smartphone, X } from "lucide-react";
import type { CommandClientOption, CommandDeviceCycle, CommandPhone, CommandRun, CommandSchedule, CycleTemplateOption } from "./command-center";
import { addDateDays, buildFleetPlan, dateInZone, dayStart, findOpenSlot, weekStart, type FleetEvent, type PlanningRun, type PlanningSnapshot } from "@/lib/scheduler/fleet-planning";
import { phaseWindows } from "@/lib/scheduler/phase-plan";
import styles from "./fleet-planner.module.css";

type Props = {
  phones: CommandPhone[]; clients: CommandClientOption[]; cycles: CommandDeviceCycle[]; schedules: CommandSchedule[];
  templates: CycleTemplateOption[]; capacity: number | null; used: number | null; demo: boolean; initialNow: string;
  connected: boolean; dataLoading: boolean; refreshToken?: number; onViewSchedule: (id: string) => void; onViewRun: (run: CommandRun) => void;
  onOpenIntegration: () => void; onNotify: (message: string, tone?: "success" | "error") => void;
};
const EMPTY: PlanningSnapshot = { runs: [], schedules: [], truncated: false, loadedAt: "" };
const PHASES: Record<string,string> = { warmup: "Warmup", money: "Money tasks", final: "Final squeeze", after: "After action", after_action: "After action", squeeze: "Final squeeze" };
function phaseName(cycle: CommandDeviceCycle) {
  const phase = cycle.currentPhase ?? (cycle.phasePlan ? phaseWindows(cycle.phasePlan).find(p => cycle.currentDay >= p.startDay && cycle.currentDay <= p.endDay)?.kind : null);
  return phase ? PHASES[phase] ?? phase.replaceAll("_", " ") : `Day ${cycle.currentDay} / ${cycle.durationDays}`;
}
function sampleSnapshot(phones: CommandPhone[], clients: CommandClientOption[], schedules: CommandSchedule[], from: number, through: number, now: number): PlanningSnapshot {
  const records: PlanningRun[] = [];
  for (let day = from; day < through; day += 86400_000) {
    for (let n = 0; n < phones.length * 5; n++) {
      const phone = phones[n % phones.length];
      const due = day + 8 * 3600_000 + Math.floor(n / 3) * 35 * 60_000;
      const start = due; const end = start + 20 * 60_000;
      const status = end < now ? "succeeded" : start <= now ? "running" : "pending";
      records.push({ id: `sample:${day}:${n}`, scheduleId: schedules[n % Math.max(1,schedules.length)]?.id ?? "sample", clientId: phone.clientId ?? clients[0]?.id ?? "sample",
        phoneId: phone.id, templateId: "demo-template-standard", scheduledFor: new Date(due).toISOString(), issueAt: new Date(due).toISOString(), status, stage: status === "succeeded" ? "complete" : "monitor_task",
        expectedDurationSeconds: 1200, startedAt: status === "pending" ? null : new Date(start).toISOString(), finishedAt: status === "succeeded" ? new Date(end).toISOString() : null,
        windowEndAt: null, attemptCount: status === "pending" ? 0 : 1, maxAttempts: 3, lastError: null, deviceCycleId: null });
    }
  }
  return { runs: records, schedules: [], truncated: false, loadedAt: new Date(now).toISOString() };
}

export function FleetPlanner(props: Props) {
  const [timezone, setTimezone] = useState("America/New_York");
  const [date, setDate] = useState(() => dateInZone(props.initialNow, "America/New_York"));
  const [zoom, setZoom] = useState(6);
  const [calendarWidth, setCalendarWidth] = useState(1000);
  const [mode, setMode] = useState<"day" | "week">("day");
  const [clientId, setClientId] = useState("all");
  const [snapshot, setSnapshot] = useState<PlanningSnapshot>(EMPTY);
  const [loadError, setError] = useState("");
  const [loadedKey, setLoadedKey] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [now, setNow] = useState(Date.parse(props.initialNow));
  const [startup, setStartup] = useState(2);
  const [spacing, setSpacing] = useState(15);
  const [settings, setSettings] = useState(false);
  const [expandedClient, setExpandedClient] = useState<string | null>(null);
  const [selected, setSelected] = useState<FleetEvent | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [openTime, setOpenTime] = useState<{ lane: number; start: number; end: number; key: string } | null>(null);
  const timeline = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const lastFocus = useRef<HTMLElement | null>(null);
  const week = weekStart(date);
  const from = Number(dayStart(week, timezone));
  const through = Number(dayStart(addDateDays(week, 7), timezone));
  const requestKey = `${from}:${through}:${refresh}:${props.refreshToken ?? 0}`;
  const loading = !props.demo && loadedKey !== requestKey;
  const error = loadedKey === requestKey ? loadError : "";
  const selectedStart = dayStart(date, timezone);
  const selectedEnd = dayStart(addDateDays(date, 1), timezone);
  const clock = (instant: number | null, withDate = false) => instant == null ? "Not available" : new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, hour: "numeric", minute: "2-digit", ...(withDate ? { month: "short", day: "numeric" } as const : {}),
  }).format(instant);
  const shortDate = (day: string) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", weekday: "short" }).format(new Date(`${day}T12:00:00Z`));

  useEffect(() => {
    if (props.demo) return;
    const controller = new AbortController();
    fetch(`/api/planning?from=${encodeURIComponent(new Date(from).toISOString())}&through=${encodeURIComponent(new Date(through).toISOString())}`, { cache: "no-store", signal: controller.signal })
      .then(async response => { const body = await response.json(); if (!response.ok || !body.data) throw new Error(body.error?.message ?? "Planning data could not be loaded."); return body.data as PlanningSnapshot; })
      .then(data => { if (!controller.signal.aborted) { setSnapshot(data); setError(""); setNow(Date.now()); } })
      .catch(cause => { if (!controller.signal.aborted) { setSnapshot(EMPTY); setError(cause instanceof Error ? cause.message : "Planning data could not be loaded."); } })
      .finally(() => { if (!controller.signal.aborted) setLoadedKey(requestKey); });
    return () => controller.abort();
  }, [from, through, requestKey, props.demo]);
  useEffect(() => { const timer = window.setInterval(() => { if (document.visibilityState === "visible") { setRefresh(v => v + 1); setNow(Date.now()); } }, 60_000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    if (!selected || !dialog.current) return;
    lastFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = dialog.current;
    node.showModal();
    return () => { node.close(); lastFocus.current?.focus(); };
  }, [selected]);
  useEffect(() => {
    const node = timeline.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(entries => setCalendarWidth(entries[0].contentRect.width));
    observer.observe(node); return () => observer.disconnect();
  }, [mode, loading, props.dataLoading, props.capacity]);

  const data = useMemo(() => props.demo ? sampleSnapshot(props.phones, props.clients, props.schedules, from, through, now) : loading ? EMPTY : snapshot,
    [loading, props.demo, props.phones, props.clients, props.schedules, from, through, now, snapshot]);
  const planningPhones = useMemo(() => props.demo ? props.phones.map(phone => ({ ...phone, status: data.runs.some(r => r.phoneId === phone.id && r.status === "running") ? 1 : 2 })) : props.phones, [props.demo, props.phones, data.runs]);
  const capacity = props.demo ? 3 : props.capacity;
  const used = props.demo ? planningPhones.filter(p => p.status === 1).length : props.used;
  const plan = useMemo(() => buildFleetPlan(data, { from, through, now, capacity, used, phones: planningPhones, startupMinutes: startup, spacingMinutes: spacing }),
    [data, from, through, now, capacity, used, planningPhones, startup, spacing]);
  const planKey = `${startup}:${spacing}:${data.loadedAt}`;
  const visibleStart = mode === "week" ? from : selectedStart;
  const visibleEnd = mode === "week" ? through : selectedEnd;
  const events = plan.events.filter(e => e.due >= visibleStart && e.due < visibleEnd && (clientId === "all" || e.clientId === clientId));
  const completed = events.filter(e => e.status === "succeeded").length;
  const spills = (event: FleetEvent) => event.status !== "succeeded" && event.end != null && event.end > visibleEnd;
  const spillover = events.filter(spills).length;
  const attention = events.filter(e => e.attention || e.status === "failed" || spills(e)).length;
  const unfinished = events.filter(e => e.status !== "succeeded");
  const finish = unfinished.length && unfinished.every(e => e.end != null && e.status !== "failed" && e.status !== "paused") ? Math.max(...unfinished.map(e => e.end!)) : null;
  const hasUnplaced = unfinished.some(e => e.end == null || ["failed", "paused"].includes(e.status));
  const ready = !loading && !props.dataLoading && !error && (props.demo || Boolean(snapshot.loadedAt));
  const reliable = ready && plan.reliable;
  const backlog = plan.events.filter(e => e.due < visibleStart && !["succeeded", "failed"].includes(e.status)).length;
  const names = new Map(props.clients.map(c => [c.id,c.name]));
  const phones = new Map(props.phones.map(p => [p.id,p.name]));
  const templates = new Map(props.templates.map(t => [t.id,t.name]));
  const titleFor = (event: FleetEvent) => ["Scheduled task", "Cycle task"].includes(event.title) ? templates.get(event.templateId) ?? event.title : event.title;
  const free = reliable ? findOpenSlot(plan, 15 + startup, Math.max(now, visibleStart)) : null;
  const phaseFor = (id: string) => {
    const labels = [...new Set(props.cycles.filter(c => c.clientId === id && ["active","paused","blocked","provisioning"].includes(c.status)).map(phaseName))];
    return labels.length > 1 ? "Multiple phases" : labels[0] ?? "Recurring tasks";
  };
  const firstStart = Math.min(...plan.events.filter(event => event.start != null && event.start >= selectedStart && event.start < selectedEnd).map(event => event.start!));
  const defaultAnchor = dateInZone(now, timezone) === date ? now : Number.isFinite(firstStart) ? firstStart : selectedStart + 8 * 3600_000;
  const focusTime = openTime?.key === planKey && openTime.start >= selectedStart && openTime.start < selectedEnd ? openTime.start : defaultAnchor;
  useEffect(() => {
    if (mode !== "day" || !timeline.current) return;
    const hours = (focusTime - selectedStart) / 3600_000;
    timeline.current.scrollLeft = Math.max(0, Math.min(hours - 1, 23)) * Math.max(480, calendarWidth - 124) / zoom;
  }, [mode, selectedStart, focusTime, calendarWidth, zoom, loading, props.dataLoading]);
  function selectEvent(event: FleetEvent) { setSelected(event); }
  async function inspectRun() {
    if (!selected?.runId) return;
    if (props.demo) { props.onNotify("Sample run. Execution evidence is available for real runs in your live workspace."); return; }
    setInspecting(true);
    try {
      const response = await fetch(`/api/runs/${encodeURIComponent(selected.runId)}`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok || !body.data?.run) throw new Error(body.error?.message ?? "Run evidence could not be loaded.");
      setSelected(null); props.onViewRun(body.data.run as CommandRun);
    } catch (cause) { props.onNotify(cause instanceof Error ? cause.message : "Run evidence could not be loaded.", "error"); }
    finally { setInspecting(false); }
  }
  const statuses: Record<string,string> = { succeeded: "Completed", pending: "Pending", queued: "Queued", running: "Running", preparing: "Preparing", failed: "Failed", retry_wait: "Retry waiting", projected: "Projected", paused: "Paused" };

  return <div className={styles.planner}>
    <section className={styles.metrics} aria-label="Planning summary">
      {[{ icon: Check, tone: "teal", value: ready ? `${completed} / ${events.length}` : "—", label: "Tasks complete", note: mode === "day" ? shortDate(date) : "Selected week" },
        { icon: Smartphone, tone: "blue", value: `${used ?? "—"} / ${capacity ?? "—"}`, label: "Startup slots in use", note: `${props.phones.length} eligible phones` },
        { icon: Clock3, tone: "blue", value: !ready ? "—" : reliable && finish ? clock(finish, dateInZone(finish,timezone) !== date) : events.length && !unfinished.length ? "Complete" : "—", label: "Estimated finish", note: hasUnplaced ? "Resolve unplaced work" : spillover ? `Extends beyond selected ${mode}` : "Current queue + buffers" },
        { icon: AlertTriangle, tone: "amber", value: ready ? String(attention) : "—", label: "Needs attention", note: "Failed, delayed or unplaced" }].map(metric => <article key={metric.label}><span className={`${styles.metricIcon} ${styles[metric.tone]}`}><metric.icon size={21}/></span><div><strong>{metric.value}</strong><span>{metric.label}</span><small>{metric.note}</small></div></article>)}
    </section>
    {error && <div className={styles.warning} role="alert"><AlertTriangle size={18}/><span>{error}</span><button onClick={() => setRefresh(v=>v+1)}>Try again</button></div>}
    <section className={styles.panel} aria-labelledby="fleet-schedule-title">
      <div className={styles.panelHeading}><h2 id="fleet-schedule-title">Fleet schedule</h2><button className={styles.iconButton} aria-label="Refresh planning data" onClick={() => setRefresh(v=>v+1)}><RefreshCw size={17} className={loading ? "spin" : ""}/></button></div>
      <div className={styles.toolbar}><div className={styles.dateControls}><button onClick={() => setDate(dateInZone(Date.now(),timezone))}>Today</button><button className={styles.iconButton} aria-label="Previous planning period" onClick={() => setDate(addDateDays(date,mode === "day" ? -1 : -7))}><ChevronLeft size={17}/></button><button className={styles.iconButton} aria-label="Next planning period" onClick={() => setDate(addDateDays(date,mode === "day" ? 1 : 7))}><ChevronRight size={17}/></button><input type="date" aria-label="Planning date" value={date} onChange={e => { if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) setDate(e.target.value); }}/></div>
        <div className={styles.viewControls}>{mode === "day" && <select aria-label="Timeline zoom" value={zoom} onChange={e=>setZoom(Number(e.target.value))}>{[2,6,12,24].map(hours=><option key={hours} value={hours}>{hours}h view</option>)}</select>}<div className={styles.segment} role="group" aria-label="Calendar view"><button aria-pressed={mode === "day"} onClick={() => setMode("day")}>Day</button><button aria-pressed={mode === "week"} onClick={() => setMode("week")}>Week</button></div><select aria-label="Filter planning by client" value={clientId} onChange={e=>setClientId(e.target.value)}><option value="all">All clients</option>{props.clients.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></div></div>
      <div className={styles.subtoolbar}><select aria-label="Planning timezone" value={timezone} onChange={e=>setTimezone(e.target.value)}>{["America/New_York","America/Chicago","America/Denver","America/Los_Angeles","Europe/London","UTC"].map(zone=><option key={zone}>{zone}</option>)}</select><span>Forecast includes startup and spacing buffers</span><button onClick={() => setSettings(!settings)} aria-expanded={settings}><SlidersHorizontal size={14}/> Forecast settings</button></div>
      {settings && <div className={styles.settings}><label>Startup buffer <input aria-label="Startup buffer minutes" type="number" min={0} max={30} value={startup} onChange={e=>setStartup(Math.max(0,Math.min(30,Number(e.target.value)||0)))}/> min / task</label><label>Spacing buffer <input aria-label="Spacing buffer minutes" type="number" min={0} max={60} value={spacing} onChange={e=>setSpacing(Math.max(0,Math.min(60,Number(e.target.value)||0)))}/> min</label><p>Planning assumptions only. These controls do not change live dispatch rules. Retries and provider delays can extend the finish time.</p></div>}
      {loading || props.dataLoading ? <div className={styles.empty} role="status"><RefreshCw className="spin" size={22}/><strong>Loading the complete planning window…</strong></div> : !capacity ? <div className={styles.empty}><Smartphone size={28}/><strong>Connect your fleet to reveal the schedule</strong><p>Your subscription limit determines the number of parallel lanes.</p><button onClick={props.onOpenIntegration}>Sync DuoPlus capacity</button></div> : mode === "day" ? <div ref={timeline} className={styles.timelineScroll} role="region" aria-label="Daily slot calendar" tabIndex={0}><div className={styles.timeline} style={{ minWidth: 124 + Math.max(480,calendarWidth-124) * ((selectedEnd-selectedStart)/3600_000) / zoom }}>
        <div className={styles.axis}><span>Startup slots</span><div>{Array.from({length:Math.round((selectedEnd-selectedStart)/3600_000)+1},(_,n)=><span key={n} style={{left:`${n*3600_000/(selectedEnd-selectedStart)*100}%`}}>{clock(selectedStart + n*3600_000)}</span>)}</div></div>
        {Array.from({length:capacity},(_,lane)=><div className={styles.lane} key={lane}><div className={styles.laneLabel}><strong>Slot {lane+1}</strong><small>{plan.events.find(e=>e.lane === lane && e.start != null && e.start<=now && e.end!>now)?.status === "running" ? "Running" : "Planned capacity"}</small></div><div className={styles.track}>
          {plan.events.filter(e=>e.lane === lane && e.start != null && e.end != null && e.start<selectedEnd && e.end>selectedStart).map(e=>{
            const left=Math.max(selectedStart,e.start!); const right=Math.min(selectedEnd,e.end!);
            return <button key={e.id} className={`${styles.event} ${e.projected?styles.projected:""} ${e.status === "succeeded" ? styles.completed : ""} ${e.attention?styles.risk:""} ${clientId !== "all" && e.clientId !== clientId ? styles.muted : ""}`} style={{left:`${(left-selectedStart)/(selectedEnd-selectedStart)*100}%`,width:`${(right-left)/(selectedEnd-selectedStart)*100}%`}} onClick={()=>selectEvent(e)} title={`${phones.get(e.phoneId??"")??"Unassigned"} · ${names.get(e.clientId)??"Client"} · ${e.title} · ${clock(e.start)}–${clock(e.end)}`} aria-label={`Inspect ${phones.get(e.phoneId??"")??"unassigned phone"}, ${titleFor(e)}, ${statuses[e.status]??e.status}`}><strong>{phones.get(e.phoneId??"")??"Unassigned"} · {templates.get(e.templateId)??e.title}</strong><span>{clock(e.start)}–{clock(e.end)}</span></button>;
          })}
          {openTime?.key === planKey && openTime.lane === lane && openTime.start < selectedEnd && openTime.end > selectedStart && <span className={styles.openHighlight} style={{left:`${(Math.max(selectedStart,openTime.start)-selectedStart)/(selectedEnd-selectedStart)*100}%`,width:`${(Math.min(selectedEnd,openTime.end)-Math.max(selectedStart,openTime.start))/(selectedEnd-selectedStart)*100}%`}}/>}
          {now>=selectedStart&&now<selectedEnd&&<span className={styles.nowLine} style={{left:`${(now-selectedStart)/(selectedEnd-selectedStart)*100}%`}}/>}
        </div></div>)}
      </div></div> : <div className={styles.weekScroll}><div className={styles.weekGrid}>{Array.from({length:7},(_,n)=>{
        const day=addDateDays(week,n);const start=dayStart(day,timezone);const end=dayStart(addDateDays(day,1),timezone);const list=plan.events.filter(e=>e.due>=start&&e.due<end&&(clientId==="all"||e.clientId===clientId));const done=list.filter(e=>e.status==="succeeded").length;
        return <button key={day} className={day === date ? styles.selectedDay:""} onClick={()=>{setDate(day);setMode("day");}}><strong>{shortDate(day)}</strong><span>{done} / {list.length} complete</span><progress aria-label={`Completion for ${shortDate(day)}`} max={list.length||1} value={done}/><small>{list.filter(e=>e.attention).length} need attention</small>{Array.from({length:capacity},(_,lane)=><div className={styles.weekLane} key={lane}><b>Slot {lane+1}</b><span>{plan.events.filter(e=>e.lane===lane&&e.start!<end&&e.end!>start).length} tasks planned</span></div>)}</button>;
      })}</div></div>}
      <div className={styles.calendarFooter}><div className={styles.legend}><span><i/>Recorded run</span><span><i className={styles.projectedKey}/>Projected occurrence</span><span><i className={styles.openKey}/>Open time</span></div><button disabled={!free || loading} onClick={()=>{if(free){setDate(dateInZone(free.start,timezone));setMode("day");setOpenTime({...free,key:planKey});props.onNotify(`Slot ${free.lane+1}: ${clock(free.start,true)}–${clock(free.end)} for a 15-minute task plus startup. Phone eligibility still applies.`);}}}>Find open time <ArrowUpRight size={15}/></button></div>
      {clientId!=="all"&&<p className={styles.note}>Other clients stay visible in the timeline to show shared capacity.</p>}
      {spillover>0&&<p className={`${styles.note} ${styles.periodWarning}`}>{spillover} unfinished task{spillover===1?" is":"s are"} estimated to finish after this {mode}. Review the finish time and available capacity.</p>}
      {backlog>0&&<p className={styles.note}>{backlog} earlier unfinished occurrence{backlog===1?"":"s"} included in the capacity forecast.</p>}
      {plan.warnings.length>0&&!loading&&<div className={styles.warning}><AlertTriangle size={17}/><div>{plan.warnings.map(w=><p key={w}>{w}</p>)}</div></div>}
      {ready&&events.length===0&&<div className={styles.empty}><CalendarDays size={24}/><strong>No work planned for this period</strong><p>Add a recurring schedule or launch a device cycle to populate your calendar.</p></div>}
    </section>
    <section className={`${styles.outlook} ${!reliable || hasUnplaced || spillover ? styles.outlookWarning:""}`} aria-label="Capacity outlook"><span><CalendarDays size={23}/></span><div><strong>{!ready ? "Loading capacity outlook" : !reliable ? "Forecast needs attention" : hasUnplaced ? "Some tasks need a scheduling decision" : spillover ? `Work extends beyond this ${mode}` : free ? "Room for the next task" : "The planning window is full"}</strong><p>{ready&&reliable&&free ? `Next 15-minute opening: Slot ${free.lane+1}, ${clock(free.start,true)}. Startup buffer included.` : "Forecast based on current queue and estimated durations."}</p></div><button onClick={()=>{setSettings(true); document.getElementById("fleet-schedule-title")?.scrollIntoView({block:"start"});}}>Inspect forecast</button></section>
    <section className={styles.panel} aria-labelledby="client-progress-title"><div className={styles.panelHeading}><div><h2 id="client-progress-title">Client progress</h2><p>{mode === "day" ? "Daily" : "Weekly"} completion and dedicated devices, together.</p></div><span className={styles.clientCount}>{props.clients.length} clients</span></div><div className={styles.clientTableScroll}><table className={styles.clientTable}><thead><tr><th>Client</th><th>Phones</th><th>Phase</th><th>Completion</th><th>Attention</th></tr></thead><tbody>{props.clients.filter(c=>clientId === "all" || clientId === c.id).map(c=>{
      const list=events.filter(e=>e.clientId===c.id);const done=list.filter(e=>e.status==="succeeded").length;const assigned=props.phones.filter(p=>p.clientId===c.id);const count=list.filter(e=>e.attention||spills(e)).length;
      return <ClientProgress key={c.id} client={c.name} expanded={expandedClient===c.id} onClick={()=>setExpandedClient(expandedClient===c.id?null:c.id)} phones={assigned} phase={phaseFor(c.id)} events={list} done={done} attention={count} ready={ready} onSelect={selectEvent} titleFor={titleFor}/>;
    })}</tbody></table></div>{!props.clients.length&&<div className={styles.empty}><strong>Your clients will appear here</strong><p>Create a client in the schedule builder and assign their dedicated phones.</p></div>}<p className={styles.note}>Forecasts are estimates. Completed tasks require confirmed results. Calendar recurrences are projected; cycle tasks appear when recorded.</p><p className={styles.note}>{props.demo ? "Sample data only. No phones are controlled." : snapshot.loadedAt ? `Planning data refreshed ${clock(Date.parse(snapshot.loadedAt))}. Auto-refreshes each minute while visible.` : ""}</p></section>
    {selected&&<dialog ref={dialog} aria-label="Task details" className={styles.drawer} onCancel={()=>setSelected(null)} onClick={e=>{if(e.target===e.currentTarget)setSelected(null);}}><div className={styles.drawerHeading}><h2>Task details</h2><button onClick={()=>setSelected(null)} aria-label="Close task details"><X size={20}/></button></div><h3>{titleFor(selected)}</h3><span className={styles.recordType}>{selected.projected ? "Projected occurrence · not dispatched" : "Recorded run"}</span><dl className={styles.details}>
      {[['Client',names.get(selected.clientId)??"Unassigned"],['Phone',phones.get(selected.phoneId??"")??"Unassigned"],['Status',statuses[selected.status]??selected.status],['Template',templates.get(selected.templateId)??"Cycle template"],['Duration',`${selected.durationMinutes} min`],['Attempts',`${selected.attemptCount} of ${selected.maxAttempts}`],['Requested start',clock(selected.due,true)],['Startup slot',selected.lane==null?"Not placed":`Slot ${selected.lane+1}`]].map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      <div className={styles.timing}><strong>{selected.status === "succeeded" ? "Recorded timing" : "Estimated timing"}</strong><p>Start <b>{clock(selected.start,true)}</b></p><p>Finish <b>{clock(selected.end,true)}</b></p><small>{selected.status === "succeeded" ? "Based on stored execution timestamps." : `Includes a ${startup}-minute startup allowance for queued work. Scheduling estimate only.`}</small></div>
      {selected.reason&&<div className={styles.warning}><AlertTriangle size={17}/><p>{selected.reason}</p></div>}
      <div className={styles.drawerActions}>{props.schedules.some(s=>s.id===selected.scheduleId)&&<button onClick={()=>{props.onViewSchedule(selected.scheduleId);setSelected(null);}}>Open schedule</button>}{selected.runId&&<button className={styles.primary} disabled={inspecting} onClick={()=>void inspectRun()}>{inspecting ? "Loading…" : "Open execution evidence"}</button>}</div>
    </dialog>}
  </div>;
}

function ClientProgress({client,phones,phase,events,done,attention,expanded,onClick,onSelect,ready,titleFor}:{client:string;phones:CommandPhone[];phase:string;events:FleetEvent[];done:number;attention:number;expanded:boolean;onClick:()=>void;onSelect:(event:FleetEvent)=>void;ready:boolean;titleFor:(event:FleetEvent)=>string}) {
  return <><tr><td><button className={styles.clientButton} onClick={onClick} aria-expanded={expanded}><span className={styles.initials}>{client.split(" ").slice(0,2).map(s=>s[0]).join("")}</span><strong>{client}</strong><ChevronRight size={15} style={{transform:expanded?"rotate(90deg)":undefined}}/></button></td><td>{phones.length}</td><td><span className={styles.phaseDot}/>{phase}</td><td><div className={styles.completion}><progress aria-label={`${client} task completion`} max={events.length||1} value={done}/><span>{ready?`${done} / ${events.length}`:"—"}</span></div></td><td>{ready?(attention||"—"):"—"}</td></tr>{expanded&&<tr><td colSpan={5}><div className={styles.phoneList}><div className={styles.mobileClientMeta}>{phase} · {phones.length} dedicated phones · {attention} need attention</div>{phones.length?phones.map(phone=>{
    const tasks=events.filter(e=>e.phoneId===phone.id);return <article key={phone.id}><div><Smartphone size={17}/><strong>{phone.name}</strong><span>{phone.status===1?"On":"Off"} · {tasks.filter(e=>e.status==="succeeded").length}/{tasks.length} complete</span></div><div>{tasks.map(task=><button key={task.id} onClick={()=>onSelect(task)}><span className={task.attention?styles.taskRisk:""}>{task.status.replaceAll("_"," ")}</span>{titleFor(task)}<ArrowUpRight size={13}/></button>)}</div></article>;
  }):<p>No dedicated phones assigned.</p>}</div></td></tr>}</>;
}
