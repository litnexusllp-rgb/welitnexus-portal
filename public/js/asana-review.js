/* Admin task review: dates refer to the office timezone returned by the server. */
(function () {
  'use strict';
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const time=(s,zone)=>new Date(s).toLocaleString('en-GB',{timeZone:zone,dateStyle:'medium',timeStyle:'short'});
  function historyHtml(t,zone) {
    if(t.historyError)return `<p role="alert">Activity unavailable. Deadline-change counts are unknown.</p>`;
    if(!t.history.length)return '<p>No due-date activity returned by Asana up to this report date.</p>';
    return `<ol class="review-timeline">${[...t.history].reverse().map(h=>`<li><strong>${esc(h.by)}</strong> · ${esc(time(h.at,zone))}<br>${h.known?`${esc(h.oldAt?time(h.oldAt,zone):h.oldDue||'Not set')} → ${esc(h.newAt?time(h.newAt,zone):h.newDue||'Not set')}`:'Previous / new date unavailable'} · <strong>${esc(h.category)}</strong>${h.postponed?' · Postponed':h.changed===false?' · Due date unchanged (start date may have changed)':''}${h.inWindow?' · In 7-day review window':''}${!h.known?`<p>${esc(h.text)}</p>`:''}</li>`).join('')}</ol>`;
  }
  function reportHtml(report,{staff='',filter='all'}={}) {
    const rows=report.rows.filter(t=>(!staff||(t.assigneeGid||'unassigned')===staff)&&(filter==='all'||filter==='repeat'&&t.changes>=2||filter==='postponed'&&t.postponements>=2||filter==='due'&&['Overdue','Due today'].includes(t.status)||filter==='unknown'&&(!t.pendingKnown||!t.dueKnown||t.historyError||t.unknownChanges)));
    const confirmed=rows.filter(t=>t.pendingKnown),groups=new Map();
    for(const t of rows){const id=t.assigneeGid||'unassigned';if(!groups.has(id))groups.set(id,{name:t.assignee,rows:[]});groups.get(id).rows.push(t);}
    const groupRows=[...groups.values()].sort((a,b)=>a.name.localeCompare(b.name));
    return `<div class="cards"><div class="card stat"><div class="label">Aged pending · shown</div><div class="value">${confirmed.length}</div></div><div class="card stat"><div class="label">Due / overdue · shown</div><div class="value">${confirmed.filter(t=>['Overdue','Due today'].includes(t.status)).length}</div></div><div class="card stat"><div class="label">Changed 2+ times · shown</div><div class="value">${confirmed.filter(t=>t.changes>=2).length}</div></div><div class="card stat"><div class="label">History needs review · shown</div><div class="value">${rows.filter(t=>!t.pendingKnown||!t.dueKnown||t.historyError||t.unknownChanges).length}</div></div></div>
      <p class="page-sub">Report date: <strong>${esc(report.date)}</strong> · Activity window: selected date and six preceding days · Collected ${esc(time(report.startedAt,report.timezone))}–${esc(time(report.observedAt,report.timezone))} (${esc(report.timezone)}). ${report.scanned} tasks scanned, including subtasks. Staff shown below are current assignees.</p>
      ${groupRows.length?groupRows.map(g=>`<section class="section"><h2>${esc(g.name)} <span class="page-sub">${g.rows.length} ${g.rows.length===1?'task':'tasks'}</span></h2><div class="table-wrap"><table class="review-table"><thead><tr><th>Task</th><th>Age</th><th>Due on report date</th><th>Changes / postponed<br>last 7 days</th><th>Recorded context</th></tr></thead><tbody>${g.rows.sort((a,b)=>(b.changes||0)-(a.changes||0)||b.age-a.age).map(t=>`<tr><td><a href="https://app.asana.com/0/0/${encodeURIComponent(t.gid)}" target="_blank" rel="noopener noreferrer">${esc(t.name)}</a><p class="page-sub">${esc(t.projects.join(' · '))}${t.parent?' / '+esc(t.parent):''}</p><details><summary>Deadline history (${t.history.length})</summary>${historyHtml(t,report.timezone)}</details></td><td>${t.age} days</td><td>${esc(t.dueKnown?t.due||'Not set':'Unknown')}<p>${esc(t.status)}</p></td><td>${t.changes===null?'Unknown':t.changes} / ${t.postponements===null?'Unknown':t.postponements}${t.unknownChanges?`<p>${t.unknownChanges} date records incomplete</p>`:''}</td><td>${esc(t.tags.join(' · '))}${t.comment?`<p>${esc(t.comment.text)}</p><p class="page-sub">${esc(t.comment.by)} · ${esc(time(t.comment.at,report.timezone))}</p>`:'<p>No comment returned up to this date.</p>'}</td></tr>`).join('')}</tbody></table></div></section>`).join(''):'<div class="empty">No tasks match these filters.</div>'}<details class="section"><summary>Report coverage and date definitions</summary><p>${esc(report.notice)}</p><p>Projects: ${esc(report.projects.join(', '))}. Missing history is not treated as zero changes. Aged tasks may have recent progress; this report does not measure effort.</p></details>`;
  }
  async function mount(root,{api,onInterval}) {
    root.innerHTML=`<div class="toolbar review-controls"><div class="field"><label for="reviewDate">Report date</label><input type="date" id="reviewDate"></div><div class="field"><label for="reviewAge">Minimum task age (days)</label><input type="number" id="reviewAge" min="0" max="3650" value="6"></div><button class="btn btn-primary" id="reviewLoad">Pull from Asana</button><div class="field"><label for="reviewStaff">Staff</label><select id="reviewStaff"><option value="">All staff</option></select></div><div class="field"><label for="reviewFilter">Show</label><select id="reviewFilter"><option value="all">All aged pending</option><option value="due">Due today / overdue</option><option value="repeat">Changed 2+ times</option><option value="postponed">Postponed 2+ times</option><option value="unknown">History needs review</option></select></div></div><p id="reviewStatus" role="status" aria-live="polite"></p><div id="reviewResults"></div>`;
    const $=s=>root.querySelector(s);let report=null,reading=false,loading=false,polling=false,pendingRead=false;
    const render=()=>{$('#reviewResults').innerHTML=report?reportHtml(report,{staff:$('#reviewStaff').value,filter:$('#reviewFilter').value}):'<div class="empty">Choose a date and pull a report. Reading the task history may take several minutes.</div>';};
    const selected=()=>({date:$('#reviewDate').value,minAge:Number($('#reviewAge').value)});
    async function load(){
      if(!root.isConnected)return;if(reading){pendingRead=true;return;}reading=true;const opt=selected();
      try {
        const data=await api.get('/asana-review?'+new URLSearchParams(opt));
        if(!root.isConnected || JSON.stringify(opt)!==JSON.stringify(selected()))return;
        if(!$('#reviewDate').value)$('#reviewDate').value=data.today;
        $('#reviewDate').max=data.today;
        const changed=report?.observedAt!==data.report?.observedAt || report?.date!==data.report?.date || report?.minAge!==data.report?.minAge;
        report=data.report;
        const keep=$('#reviewStaff').value;
        const owners=new Map((report?.rows||[]).map(t=>[t.assigneeGid||'unassigned',t.assignee]));
        $('#reviewStaff').innerHTML='<option value="">All staff</option>'+[...owners].sort((a,b)=>a[1].localeCompare(b[1])).map(([id,name])=>`<option value="${esc(id)}">${esc(name)}</option>`).join('');
        if(owners.has(keep))$('#reviewStaff').value=keep;
        const job=data.job;
        polling=job?.state==='running';
        $('#reviewLoad').disabled=loading||job?.state==='running';
        $('#reviewStatus').textContent=job?.state==='running'?`${job.message} · ${job.done}${job.total===null?'':' / '+job.total} · report ${job.date}`:job?.state==='error'?job.message:report?'Saved report loaded. Pull from Asana refreshes it (cached for five minutes).':'No saved report for this date. Pull from Asana to collect it.';
        if(changed || !report)render();
      }catch(e){if(root.isConnected)$('#reviewStatus').textContent=e.message;}finally{reading=false;if(pendingRead){pendingRead=false;load();}}
    }
    $('#reviewLoad').onclick=async()=>{
      if(loading)return;loading=true;$('#reviewLoad').disabled=true;
      try{const result=await api.post('/asana-review/refresh',selected());if(root.isConnected)$('#reviewStatus').textContent=result.message||'Report requested.';await load();}
      catch(e){if(root.isConnected)$('#reviewStatus').textContent=e.message;}
      finally{loading=false;if(root.isConnected)$('#reviewLoad').disabled=false;}
    };
    $('#reviewDate').onchange=()=>{report=null;render();load();};$('#reviewAge').onchange=()=>{report=null;render();load();};
    $('#reviewStaff').onchange=render;$('#reviewFilter').onchange=render;
    await load();if(root.isConnected)onInterval(setInterval(()=>{if(polling)load();},3000));
  }
  window.AsanaReview={mount,reportHtml,historyHtml};
})();
