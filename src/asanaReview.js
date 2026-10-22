'use strict';
const { DateTime, ZONE } = require('./time');
const DEFAULT_PROJECTS = ['1215327082632826','1215327266947491','1218535164266724','1218618531489922','1218747329691843'];
const TASK_FIELDS = 'name,created_at,modified_at,completed,completed_at,assignee.name,due_on,due_at,num_subtasks,tags.name';
const STORY_FIELDS = 'created_at,created_by.name,resource_subtype,text,old_dates.due_on,old_dates.due_at,new_dates.due_on,new_dates.due_at';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const own = (o,k) => o && Object.prototype.hasOwnProperty.call(o,k);
const dateOf = (value, zone = ZONE) => value ? DateTime.fromISO(value, { zone }).setZone(zone).toISODate() : null;
function dates(value) {
  if (!value || (!own(value,'due_on') && !own(value,'due_at'))) return { known:false, on:null, at:null };
  return { known:true, on:value.due_on || null, at:value.due_at || null };
}
function category(due, day) { return !due ? 'No due date' : due < day ? 'Overdue' : due === day ? 'Due today' : 'Due in future'; }
function options(input = {}, at = Date.now()) {
  const today = DateTime.fromMillis(at, { zone:ZONE }).toISODate();
  const date = input.date || today;
  const day = DateTime.fromISO(String(date), { zone:ZONE });
  const minAge = Number(input.minAge ?? 6);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !day.isValid || day.toISODate() !== date || date > today || !Number.isInteger(minAge) || minAge < 0 || minAge > 3650) {
    throw Object.assign(new Error('Choose a valid report date up to today and an age between 0 and 3650 days.'), { status:400 });
  }
  return { date, minAge, today, cutoff:Math.min(at,day.plus({days:1}).toMillis()-1), windowStart:day.minus({days:6}).startOf('day').toMillis(), zone:ZONE };
}
// Rewind structured activity only. Story prose is displayed, never parsed as evidence.
function reviewTask(task, stories, opt, historyError = null) {
  const created = DateTime.fromISO(task.created_at || '', {zone:opt.zone}).setZone(opt.zone);
  if (!created.isValid || created.toMillis() > opt.cutoff) return null;
  const age = Math.floor(DateTime.fromISO(opt.date,{zone:opt.zone}).diff(created.startOf('day'),'days').days);
  if (age < opt.minAge) return null;
  const ordered = [...new Map(stories.map(s=>[s.gid,s])).values()].sort((a,b)=>Date.parse(a.created_at)-Date.parse(b.created_at)||String(a.gid).localeCompare(String(b.gid)));
  let completed = !!task.completed, due = dates(task), completionKnown = !historyError, dueKnown = !historyError;
  for (const s of [...ordered].reverse()) {
    if (Date.parse(s.created_at) <= opt.cutoff) continue;
    if (s.resource_subtype === 'marked_complete') completed = false;
    if (s.resource_subtype === 'marked_incomplete') completed = true;
    if (s.resource_subtype === 'due_date_changed') {
      due = dates(s.old_dates);
      if (!due.known) dueKnown = false;
    }
  }
  if (opt.date !== opt.today && task.completed && Date.parse(task.completed_at)>opt.cutoff && !ordered.some(s=>s.resource_subtype==='marked_complete' && Date.parse(s.created_at)>opt.cutoff)) completionKnown=false;
  // Today's pending state is observed directly even when the activity API fails.
  if (opt.date === opt.today) { completed=!!task.completed; completionKnown=true; due=dates(task); dueKnown=true; }
  if (completionKnown && completed) return null;
  const history = ordered.filter(s=>s.resource_subtype==='due_date_changed' && Date.parse(s.created_at)<=opt.cutoff).map(s=>{
    const old=dates(s.old_dates), next=dates(s.new_dates), changeDay=dateOf(s.created_at,opt.zone);
    const changed=old.known && next.known ? old.on!==next.on || old.at!==next.at : null;
    const newDue=next.at?dateOf(next.at,opt.zone):next.on;
    const oldDue=old.at?dateOf(old.at,opt.zone):old.on;
    return { gid:s.gid, at:s.created_at, by:s.created_by?.name || 'Unknown actor', oldDue, newDue, oldAt:old.at, newAt:next.at,
      known:old.known&&next.known, changed, category:next.known?category(newDue,changeDay):'Date details unavailable', text:s.text || '',
      inWindow:Date.parse(s.created_at)>=opt.windowStart,
      postponed:changed===true && !!oldDue && !!newDue && (old.at&&next.at ? Date.parse(next.at)>Date.parse(old.at) : newDue>oldDue) };
  });
  const recent=history.filter(h=>h.inWindow);
  const dueOn=dueKnown ? (due.at?dateOf(due.at,opt.zone):due.on) : null;
  const lastComment=[...ordered].reverse().find(s=>s.resource_subtype==='comment_added' && Date.parse(s.created_at)<=opt.cutoff);
  return { gid:task.gid, name:task.name || '(Untitled task)', assignee:task.assignee?.name || 'Unassigned', assigneeGid:task.assignee?.gid || '',
    projects:task.projectNames || [], parent:task.parentName || null, age, created:created.toISODate(), due:dueOn, dueAt:dueKnown?due.at:null,
    status:!completionKnown?'Pending state unknown':!dueKnown?'Due date unknown':category(dueOn,opt.date), pendingKnown:completionKnown, dueKnown,
    changes:historyError?null:recent.filter(h=>h.changed===true).length, postponements:historyError?null:recent.filter(h=>h.postponed).length,
    unknownChanges:recent.filter(h=>h.changed===null).length, historyError, history,
    tags:(task.tags || []).map(t=>t.name), comment:lastComment?{at:lastComment.created_at,text:lastComment.text,by:lastComment.created_by?.name || ''}:null,
    url:'https://app.asana.com/0/0/'+encodeURIComponent(task.gid) };
}

function createReview({ db, fetchImpl = (...args)=>fetch(...args), wait = sleep, clock = Date.now, env = process.env }) {
  db.exec(`CREATE TABLE IF NOT EXISTS asana_review_reports (report_key TEXT PRIMARY KEY, payload TEXT NOT NULL, saved_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS asana_review_stories (task_gid TEXT PRIMARY KEY, modified_at TEXT, fetched_at INTEGER NOT NULL, payload TEXT NOT NULL);`);
  let job=null, active=null;
  const config=()=>({token:env.ASANA_TOKEN, projects:[...new Set((env.ASANA_REVIEW_PROJECT_GIDS || DEFAULT_PROJECTS.join(',')).split(',').map(s=>s.trim()).filter(Boolean))]});
  const key=o=>JSON.stringify([o.date,o.minAge,o.zone,config().projects]);
  async function request(path, params) {
    for(let attempt=0;attempt<4;attempt++) {
      await wait(450);
      const res=await fetchImpl('https://app.asana.com/api/1.0'+path+'?'+new URLSearchParams(params),{headers:{Authorization:'Bearer '+config().token},signal:AbortSignal.timeout(30000)});
      if(res.status===429 || res.status>=500) {
        const retry=Math.max(1,Number(res.headers?.get('retry-after'))||2**attempt);
        if(attempt===3 || retry>120) throw new Error('Asana is busy. Please retry later.');
        await wait(retry*1000); continue;
      }
      if(!res.ok) throw new Error('Asana read failed ('+res.status+'). Check the server connection and task access.');
      const body=await res.json();
      if(!Array.isArray(body.data)) throw new Error('Asana returned an invalid list.');
      return body;
    }
  }
  async function pages(path,params) {
    const rows=[],seen=new Set();let offset;
    do {
      const body=await request(path,{...params,limit:'100',...(offset?{offset}:{})}); rows.push(...body.data);
      offset=body.next_page?.offset;
      if(body.next_page && !offset || offset && seen.has(offset) || seen.size>500) throw new Error('Incomplete Asana pagination. Report was not saved.');
      if(offset)seen.add(offset);
    } while(offset);
    return rows;
  }
  async function collect(opt) {
    const c=config(), tasks=new Map();
    for(const project of c.projects) {
      job.message='Reading project '+project;
      const rows=await pages('/tasks',{project,opt_fields:TASK_FIELDS+',projects.name'});
      for(const t of rows) {
        const names=(t.projects || []).map(p=>p.name);
        if(tasks.has(t.gid)) tasks.get(t.gid).projectNames=[...new Set([...tasks.get(t.gid).projectNames,...names])];
        else tasks.set(t.gid,{...t,projectNames:names});
        if(tasks.size>20000)throw new Error('Task limit reached. Narrow ASANA_REVIEW_PROJECT_GIDS and retry.');
      }
    }
    const queue=[...tasks.values()];
    for(let i=0;i<queue.length;i++) {
      const p=queue[i]; if(!p.num_subtasks)continue;
      job.message='Reading subtasks · '+tasks.size+' tasks found';
      for(const t of await pages('/tasks/'+encodeURIComponent(p.gid)+'/subtasks',{opt_fields:TASK_FIELDS})) {
        if(!tasks.has(t.gid)) {const item={...t,projectNames:p.projectNames,parentName:p.name};tasks.set(t.gid,item);queue.push(item);}
      }
      if(tasks.size>20000)throw new Error('Task limit reached. Narrow ASANA_REVIEW_PROJECT_GIDS and retry.');
    }
    const candidates=[...tasks.values()].filter(t=>{
      const created=DateTime.fromISO(t.created_at||'',{zone:ZONE}).setZone(ZONE);
      return created.isValid && created.toMillis()<=opt.cutoff && DateTime.fromISO(opt.date,{zone:ZONE}).diff(created.startOf('day'),'days').days>=opt.minAge &&
        !(t.completed && t.completed_at && Date.parse(t.completed_at)<=opt.cutoff);
    });
    if(candidates.length>2000)throw new Error('Too many aged tasks. Narrow the project scope and retry.');
    const rows=[];job.total=candidates.length;job.done=0;
    for(const t of candidates) {
      job.message='Reading task activity';let stories=[],error=null;
      try {
        const cached=db.prepare('SELECT * FROM asana_review_stories WHERE task_gid=?').get(t.gid);
        if(cached && cached.modified_at===t.modified_at && clock()-cached.fetched_at<300000)stories=JSON.parse(cached.payload);
        else {
          stories=await pages('/tasks/'+encodeURIComponent(t.gid)+'/stories',{opt_fields:STORY_FIELDS});
          db.prepare('INSERT OR REPLACE INTO asana_review_stories VALUES (?,?,?,?)').run(t.gid,t.modified_at || '',clock(),JSON.stringify(stories));
        }
      } catch(e) { error=e.message; }
      const row=reviewTask(t,stories,opt,error);if(row)rows.push(row);job.done++;
    }
    const report={date:opt.date,minAge:opt.minAge,timezone:ZONE,startedAt:job.startedAt,observedAt:new Date(clock()).toISOString(),projects:c.projects,
      scanned:tasks.size,rows,historyFailures:rows.filter(r=>r.historyError).length,
      notice:'Historical pending state and due dates are reconstructed from currently accessible tasks and available Asana activity. Deleted tasks, removed project members, missing or consolidated activity and changes during collection may be absent. Staff, project names and tags are current, not historical. Age is since creation, not uninterrupted inactivity. Change counts cover the selected day and six preceding days; initial date setting and start-only edits are not postponements. “Due today” / “Due in future” in the timeline are relative to the day of each change. History without structured dates is marked unknown.'};
    db.prepare('INSERT OR REPLACE INTO asana_review_reports VALUES (?,?,?)').run(key(opt),JSON.stringify(report),clock());
    return report;
  }
  function start(input) {
    const opt=options(input,clock()),c=config();
    if(!c.token)throw Object.assign(new Error('Asana is not configured on the server.'),{status:503});
    if(!c.projects.length || c.projects.some(p=>!/^\d+$/.test(p)))throw Object.assign(new Error('Invalid Asana review project configuration.'),{status:503});
    if(active)return { ...job, busy:true };
    // Share refreshes and prevent repeated full scans within five minutes.
    const saved=db.prepare('SELECT saved_at FROM asana_review_reports WHERE report_key=?').get(key(opt));
    if(saved && clock()-saved.saved_at<300000)return {state:'ready',date:opt.date,minAge:opt.minAge,cached:true};
    job={state:'running',date:opt.date,minAge:opt.minAge,done:0,total:null,message:'Reading Asana projects',startedAt:new Date(clock()).toISOString()};
    active=collect(opt).then(()=>{job={...job,state:'ready',message:'Report ready'};},()=>{job={...job,state:'error',message:'Asana refresh failed. The previous saved report is unchanged. Check connection and retry.'};}).finally(()=>{active=null;});
    return {...job};
  }
  function read(input) {
    const opt=options(input,clock());
    const saved=db.prepare('SELECT payload FROM asana_review_reports WHERE report_key=?').get(key(opt));
    return { report:saved?JSON.parse(saved.payload):null,job:job?{...job}:null,today:opt.today,timezone:ZONE };
  }
  return {start,read,waitForIdle:()=>active};
}
module.exports={createReview,reviewTask,options,category,DEFAULT_PROJECTS};
