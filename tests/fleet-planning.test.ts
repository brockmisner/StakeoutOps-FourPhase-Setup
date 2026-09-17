import { describe, expect, it } from "vitest";
import { addDateDays, buildFleetPlan, dateInZone, dayStart, findOpenSlot, weekStart, type PlanningRun, type PlanningSchedule, type PlanningSnapshot } from "@/lib/scheduler/fleet-planning";

const now = Date.parse("2026-09-17T12:00:00Z");
const phones = [{ id:"a", name:"A", imageId:"physical-a", enabled:true, status:2 },{ id:"b", name:"B", imageId:"physical-b", enabled:true, status:2 }];
const options = { from:now, through:now+7*86400_000, now, capacity:2, used:0, phones, startupMinutes:2, spacingMinutes:15 };
const iso = (minutes:number)=>new Date(now+minutes*60_000).toISOString();
function run(id:string, extra:Partial<PlanningRun>={}):PlanningRun {
  return { id, scheduleId:"s", clientId:"client", phoneId:"a", templateId:"t", scheduledFor:iso(0), issueAt:iso(0), status:"pending", stage:"queued", expectedDurationSeconds:600, startedAt:null, finishedAt:null, windowEndAt:null, attemptCount:0, maxAttempts:3, lastError:null, deviceCycleId:null, ...extra };
}
function snapshot(runs:PlanningRun[]=[], schedules:PlanningSchedule[]=[]):PlanningSnapshot {return {runs,schedules,truncated:false,loadedAt:iso(0)};}

describe("fleet capacity forecast",()=>{
  it("serializes aliases of one physical phone and includes startup and spacing",()=>{
    const data=snapshot([run("one"),run("two",{phoneId:"alias"})]);
    const plan=buildFleetPlan(data,{...options,phones:[...phones,{...phones[0],id:"alias"}]});
    expect(plan.events[0].end).toBe(now+12*60_000);
    expect(plan.events[1].start).toBe(now+27*60_000);
  });
  it("allows distinct phones to share concurrent slots",()=>{
    const plan=buildFleetPlan(snapshot([run("one"),run("two",{phoneId:"b"})]),options);
    expect(plan.events.map(e=>e.start)).toEqual([now,now]);
    expect(new Set(plan.events.map(e=>e.lane)).size).toBe(2);
  });
  it("does not count a projected occurrence twice when a run is materialized",()=>{
    const schedule:PlanningSchedule={id:"s",clientId:"client",phoneId:"a",templateId:"t",name:"Daily",keyword:"",cronExpression:"0 8 * * *",timezone:"America/New_York",enabled:true,nextRunAt:iso(0),expectedDurationSeconds:600,maxAttempts:3};
    const plan=buildFleetPlan(snapshot([run("one")],[schedule]),options);
    expect(plan.events).toHaveLength(7);
    expect(plan.events.filter(e=>e.due===now)).toHaveLength(1);
    expect(plan.events.filter(e=>e.projected)).toHaveLength(6);
  });
  it("reserves on phones with no tracked run and suppresses availability claims",()=>{
    const plan=buildFleetPlan(snapshot([run("one")]),{...options,used:1,phones:[phones[0],{...phones[1],status:1}]});
    expect(plan.reliable).toBe(false);
    expect(plan.events[0].lane).toBe(1);
    expect(findOpenSlot(plan,15)).toBeNull();
  });
  it("does not release an overrunning phone based on an expired estimate",()=>{
    const plan=buildFleetPlan(snapshot([run("one",{status:"running",startedAt:iso(-20)})]),{...options,capacity:1,used:1,phones:[{...phones[0],status:1}]});
    expect(plan.events[0].end).toBe(options.through);
    expect(plan.events[0].attention).toBe(true);
    expect(findOpenSlot(plan,15)).toBeNull();
  });
  it("never assumes three slots when capacity is unknown",()=>{
    const plan=buildFleetPlan(snapshot([run("one")]),{...options,capacity:null});
    expect(plan.events[0].start).toBeNull();
    expect(plan.capacity).toBe(0);
    expect(plan.reliable).toBe(false);
  });
  it("respects retry not-before times and execution deadlines",()=>{
    const plan=buildFleetPlan(snapshot([run("retry",{status:"retry_wait",nextActionAt:iso(45)}),run("deadline",{phoneId:"b",windowEndAt:iso(5)})]),options);
    expect(plan.events.find(e=>e.id==="retry")?.start).toBe(now+45*60_000);
    expect(plan.events.find(e=>e.id==="deadline")?.start).toBeNull();
    expect(plan.events.find(e=>e.id==="deadline")?.reason).toContain("execution window");
  });
  it("keeps failed and paused tasks unresolved rather than forecasting success",()=>{
    const plan=buildFleetPlan(snapshot([run("failed",{status:"failed"}),run("paused",{status:"paused"})]),options);
    expect(plan.events.every(e=>e.attention && e.end===null)).toBe(true);
  });
  it("finds a genuine gap including the post-task spacing reservation",()=>{
    const plan=buildFleetPlan(snapshot([run("one"),run("two",{phoneId:"b"})]),options);
    expect(findOpenSlot(plan,17)?.start).toBe(now+27*60_000);
  });
  it("suppresses complete forecasts when the feed is partial",()=>{
    const plan=buildFleetPlan({...snapshot(),truncated:true},options);
    expect(plan.reliable).toBe(false);
    expect(findOpenSlot(plan,15)).toBeNull();
  });
  it("does not mutate the source data",()=>{
    const data=snapshot([run("one")]);const original=JSON.stringify(data);buildFleetPlan(data,options);expect(JSON.stringify(data)).toBe(original);
  });
  it("forecasts 50 phones across ten clients without overbooking three subscriptions",()=>{
    const fleet=Array.from({length:50},(_,i)=>({id:`phone-${i}`,name:`Phone ${i+1}`,imageId:`physical-${i}`,enabled:true,status:2}));
    const work=Array.from({length:250},(_,i)=>run(`task-${i}`,{phoneId:fleet[i%50].id,clientId:`client-${Math.floor((i%50)/5)}`,expectedDurationSeconds:1200}));
    const plan=buildFleetPlan(snapshot(work),{...options,capacity:3,phones:fleet});
    expect(plan.events).toHaveLength(250);
    expect(plan.events.every(event=>event.lane!=null&&event.lane<3)).toBe(true);
    for(const lane of plan.lanes){
      const sorted=[...lane].sort((a,b)=>a.start-b.start);
      expect(sorted.every((item,i)=>i===0||item.start>=sorted[i-1].end)).toBe(true);
    }
    for(const phone of fleet){
      const work=plan.events.filter(event=>event.phoneId===phone.id).sort((a,b)=>a.start!-b.start!);
      expect(work.every((item,i)=>i===0||item.start!>=work[i-1].end!)).toBe(true);
    }
    expect(Math.max(...plan.events.map(event=>event.end!))).toBeGreaterThan(now+86400_000);
  });
});
describe("planning calendar dates",()=>{
  it("uses 23- and 25-hour local days across DST",()=>{
    expect(dayStart("2026-03-09","America/New_York")-dayStart("2026-03-08","America/New_York")).toBe(23*3600_000);
    expect(dayStart("2026-11-02","America/New_York")-dayStart("2026-11-01","America/New_York")).toBe(25*3600_000);
  });
  it("uses local calendar dates and a Monday week boundary",()=>{
    expect(dateInZone("2026-09-17T02:00:00Z","America/New_York")).toBe("2026-09-16");
    expect(weekStart("2026-09-20")).toBe("2026-09-14");
    expect(addDateDays("2026-12-31",1)).toBe("2027-01-01");
  });
});
