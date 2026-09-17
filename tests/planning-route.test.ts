import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only",()=>({}));
const auth=vi.hoisted(()=>({ requireOrganization:vi.fn() }));
vi.mock("@/lib/auth/context",()=>auth);
import { GET } from "@/app/api/planning/route";
import { ApiError } from "@/lib/auth/errors";
type Row=Record<string,unknown>;
function database(fixtures:Record<string,Row[]>) {
  const scopes:Array<[string,unknown][]> = [];
  const from=vi.fn((table:string)=>{
    const equal:Array<[string,unknown]>=[];
    const predicates:Array<(row:Row)=>boolean>=[];
    scopes.push(equal);
    const query={
      select:vi.fn(()=>query), order:vi.fn(()=>query),
      eq:vi.fn((key:string,value:unknown)=>{equal.push([key,value]);predicates.push(row=>row[key]===value);return query;}),
      in:vi.fn((key:string,values:unknown[])=>{predicates.push(row=>values.includes(row[key]));return query;}),
      gte:vi.fn((key:string,value:string)=>{predicates.push(row=>String(row[key])>=value);return query;}),
      lt:vi.fn((key:string,value:string)=>{predicates.push(row=>String(row[key])<value);return query;}),
      range:vi.fn(async(start:number,end:number)=>({data:(fixtures[table]??[]).filter(row=>predicates.every(p=>p(row))).slice(start,end+1),error:null})),
    };return query;
  });return {admin:{from},scopes};
}
const url="https://example.test/api/planning?from=2026-09-17T00:00:00Z&through=2026-09-24T00:00:00Z";
beforeEach(()=>vi.clearAllMocks());
describe("organization-scoped complete planning feed",()=>{
  it("pages past 1000 runs, includes earlier unfinished work, and excludes other organizations",async()=>{
    const rows:Row[]=Array.from({length:1501},(_,i)=>({id:`r${i}`,organization_id:"ours",schedule_id:"s",client_id:"client",phone_id:"p",template_id:"t",scheduled_for:"2026-09-18T00:00:00.000Z",issue_at:"2026-09-18T00:00:00.000Z",status:"pending",expected_duration_seconds:600,attempt_count:0,max_attempts:3}));
    rows.push({...rows[0],id:"foreign",organization_id:"theirs"},{...rows[0],id:"backlog",scheduled_for:"2026-09-15T00:00:00.000Z"});
    const db=database({scheduler_runs:rows,scheduler_schedules:[]});
    auth.requireOrganization.mockResolvedValue({demo:false,organizationId:"ours",admin:db.admin});
    const response=await GET(new Request(url));const body=await response.json();
    expect(response.status).toBe(200);expect(body.data.runs).toHaveLength(1502);
    expect(body.data.runs.some((r:{id:string})=>r.id==="foreign")).toBe(false);
    expect(body.data.truncated).toBe(false);
    expect(db.scopes.every(scope=>scope.some(([key,value])=>key==="organization_id"&&value==="ours"))).toBe(true);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
  it("requires authentication before reading data",async()=>{
    auth.requireOrganization.mockRejectedValue(new ApiError(401,"AUTH_REQUIRED","Sign in."));
    expect((await GET(new Request(url))).status).toBe(401);
  });
  it("rejects unbounded windows without querying the database",async()=>{
    const db=database({});auth.requireOrganization.mockResolvedValue({demo:false,organizationId:"ours",admin:db.admin});
    expect((await GET(new Request(url.replace("2026-09-24","2026-12-24")))).status).toBe(400);
    expect(db.admin.from).not.toHaveBeenCalled();
  });
});
