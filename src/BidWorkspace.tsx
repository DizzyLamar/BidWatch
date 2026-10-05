import { useEffect, useMemo, useState } from 'react';
import { Check, CircleAlert, Plus, Trash2 } from 'lucide-react';
import { api } from './platform';

type User = { id: string; name: string; active: boolean; status?: string };
type CriterionKey = 'technicalCapability' | 'relevantExperience' | 'eligibility' | 'financialCapacity' | 'strategicValue' | 'competition' | 'deliveryCapability' | 'deadlineFeasibility' | 'partnershipRequirement';
type Qualification = { decision: 'undecided' | 'bid' | 'no-bid' | 'needs-review'; score: number; criteria: Record<CriterionKey, number>; notes: string; updatedAt: string; updatedBy: string };
type Requirement = { id: string; title: string; mandatory: boolean; status: 'open' | 'met' | 'missing' | 'needs-review'; evidence: string; ownerId: string };
type Task = { id: string; title: string; assigneeId: string; dueAt: string; status: 'todo' | 'in-progress' | 'done'; priority: 'low' | 'medium' | 'high'; kind: 'internal-review' | 'technical' | 'financial' | 'submission' | 'other' };

const CRITERIA: Array<{ key: CriterionKey; label: string; help: string }> = [
  { key: 'technicalCapability', label: 'Technical capability', help: 'Can we actually deliver the required technology or service?' },
  { key: 'relevantExperience', label: 'Relevant experience', help: 'Do we have credible references and similar delivery experience?' },
  { key: 'eligibility', label: 'Eligibility', help: 'Do we satisfy mandatory registration, certification and eligibility conditions?' },
  { key: 'financialCapacity', label: 'Financial capacity', help: 'Can we satisfy turnover, security, cashflow or financial requirements?' },
  { key: 'strategicValue', label: 'Strategic value', help: 'Does this opportunity fit our target market and long-term direction?' },
  { key: 'competition', label: 'Competitive position', help: 'How credible is our position against likely competitors?' },
  { key: 'deliveryCapability', label: 'Delivery capability', help: 'Can the team deliver within the scope, geography and timeframe?' },
  { key: 'deadlineFeasibility', label: 'Deadline feasibility', help: 'Can we prepare a compliant submission before the deadline?' },
  { key: 'partnershipRequirement', label: 'Partnership requirement', help: 'How much external capability or partnering is required?' },
];

const emptyCriteria = (): Record<CriterionKey, number> => Object.fromEntries(CRITERIA.map(c => [c.key, 0])) as Record<CriterionKey, number>;

function fmt(value?: string) {
  if (!value) return 'No date';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

export default function BidWorkspace({ tenderId, revision, users, canEdit, onRevision }: { tenderId: string; revision: number; users: User[]; canEdit: boolean; onRevision: (revision: number) => void }) {
  const [qualification, setQualification] = useState<Qualification | null>(null);
  const [criteria, setCriteria] = useState<Record<CriterionKey, number>>(emptyCriteria());
  const [decision, setDecision] = useState<Qualification['decision']>('undecided');
  const [qualificationNotes, setQualificationNotes] = useState('');
  const [requirements, setRequirements] = useState<Requirement[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [newRequirement, setNewRequirement] = useState({ title: '', mandatory: true });
  const [newTask, setNewTask] = useState({ title: '', assigneeId: '', dueAt: '', priority: 'medium' as Task['priority'], kind: 'other' as Task['kind'] });

  async function load() {
    setLoading(true);
    try {
      const response = await api.get(`/api/tenders/${tenderId}/workspace`);
      const data = response.data;
      setQualification(data.qualification || null);
      setCriteria(data.qualification?.criteria ? { ...emptyCriteria(), ...data.qualification.criteria } : emptyCriteria());
      setDecision(data.qualification?.decision || 'undecided');
      setQualificationNotes(data.qualification?.notes || '');
      setRequirements(data.requirements || []);
      setTasks(data.tasks || []);
      setMessage('');
    } catch (error: any) {
      setMessage(error?.message || 'Could not load bid workspace data.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [tenderId]);

  async function saveQualification() {
    setSaving(true);
    try {
      const response = await api.put(`/api/tenders/${tenderId}/qualification`, { decision, criteria, notes: qualificationNotes, expectedRevision: revision });
      setQualification(response.data.qualification);
      onRevision(Number(response.data.tender?.revision || revision + 1));
      setMessage('Qualification saved.');
    } catch (error: any) {
      setMessage(error?.message || 'Could not save qualification.');
    } finally {
      setSaving(false);
    }
  }

  async function addRequirement(event: React.FormEvent) {
    event.preventDefault();
    if (!newRequirement.title.trim()) return;
    setSaving(true);
    try {
      const response = await api.post(`/api/tenders/${tenderId}/requirements`, newRequirement);
      setRequirements(items => [...items, response.data.requirement]);
      setNewRequirement({ title: '', mandatory: true });
      setMessage('Requirement added.');
    } catch (error: any) {
      setMessage(error?.message || 'Could not add requirement.');
    } finally {
      setSaving(false);
    }
  }

  async function updateRequirement(item: Requirement, patch: Partial<Requirement>) {
    try {
      const response = await api.put(`/api/tenders/${tenderId}/requirements/${item.id}`, patch);
      setRequirements(items => items.map(x => x.id === item.id ? response.data.requirement : x));
    } catch (error: any) {
      setMessage(error?.message || 'Could not update requirement.');
    }
  }

  async function deleteRequirement(item: Requirement) {
    try {
      await api.delete(`/api/tenders/${tenderId}/requirements/${item.id}`);
      setRequirements(items => items.filter(x => x.id !== item.id));
    } catch (error: any) {
      setMessage(error?.message || 'Could not remove requirement.');
    }
  }

  async function addTask(event: React.FormEvent) {
    event.preventDefault();
    if (!newTask.title.trim()) return;
    setSaving(true);
    try {
      const response = await api.post(`/api/tenders/${tenderId}/tasks`, newTask);
      setTasks(items => [...items, response.data.task].sort((a,b) => new Date(a.dueAt || '9999').getTime() - new Date(b.dueAt || '9999').getTime()));
      setNewTask({ title: '', assigneeId: '', dueAt: '', priority: 'medium', kind: 'other' });
      setMessage('Task added.');
    } catch (error: any) {
      setMessage(error?.message || 'Could not add task.');
    } finally {
      setSaving(false);
    }
  }

  async function updateTask(item: Task, patch: Partial<Task>) {
    try {
      const response = await api.put(`/api/tenders/${tenderId}/tasks/${item.id}`, patch);
      setTasks(items => items.map(x => x.id === item.id ? response.data.task : x));
    } catch (error: any) {
      setMessage(error?.message || 'Could not update task.');
    }
  }

  async function deleteTask(item: Task) {
    try {
      await api.delete(`/api/tenders/${tenderId}/tasks/${item.id}`);
      setTasks(items => items.filter(x => x.id !== item.id));
    } catch (error: any) {
      setMessage(error?.message || 'Could not remove task.');
    }
  }

  const requirementStats = useMemo(() => ({
    total: requirements.length,
    met: requirements.filter(x => x.status === 'met').length,
    missing: requirements.filter(x => x.status === 'missing').length,
    mandatoryOpen: requirements.filter(x => x.mandatory && x.status !== 'met').length,
  }), [requirements]);
  const completedTasks = tasks.filter(x => x.status === 'done').length;

  if (loading) return <section className="panel"><p className="muted">Loading bid workspace…</p></section>;

  return <div className="bid-workspace">
    {message && <div className="form-error" role="status">{message}</div>}

    <section className="panel">
      <div className="section-title"><div><h3>Bid / No-Bid qualification</h3><p className="muted">Make the commercial decision explicit and explain why.</p></div>{qualification && <span className={`status ${qualification.decision === 'bid' ? 'success' : qualification.decision === 'no-bid' ? 'danger' : 'neutral'}`}>{qualification.score}/100</span>}</div>
      <div className="form-grid">
        <Field label="Decision">
          <select value={decision} onChange={e => setDecision(e.target.value as Qualification['decision'])} disabled={!canEdit || saving}>
            <option value="undecided">Not decided</option><option value="needs-review">Needs review</option><option value="bid">Pursue</option><option value="no-bid">Do not pursue</option>
          </select>
        </Field>
        <Field label="Score">
          <input value={Math.round(Object.values(criteria).reduce((a,b) => a + b, 0) / CRITERIA.length * 20)} readOnly />
        </Field>
        {CRITERIA.map(item => <Field key={item.key} label={item.label}><select value={criteria[item.key]} onChange={e => setCriteria(current => ({ ...current, [item.key]: Number(e.target.value) }))} disabled={!canEdit || saving}><option value={0}>0 — Unknown / poor</option><option value={1}>1 — Very weak</option><option value={2}>2 — Weak</option><option value={3}>3 — Adequate</option><option value={4}>4 — Strong</option><option value={5}>5 — Excellent</option></select><small>{item.help}</small></Field>)}
        <Field label="Decision notes" wide><textarea rows={3} value={qualificationNotes} onChange={e => setQualificationNotes(e.target.value)} disabled={!canEdit || saving} placeholder="What evidence supports this decision? What is still uncertain?" /></Field>
      </div>
      {canEdit && <button className="primary" disabled={saving} onClick={() => void saveQualification()}>{saving ? 'Saving…' : 'Save qualification'}</button>}
    </section>

    <section className="panel">
      <div className="section-title"><div><h3>Compliance requirements</h3><p className="muted">{requirementStats.met}/{requirementStats.total} met · {requirementStats.missing} missing · {requirementStats.mandatoryOpen} mandatory items still unresolved</p></div><span className={`status ${requirementStats.mandatoryOpen ? 'warn' : 'success'}`}>{requirementStats.mandatoryOpen ? 'Review needed' : 'Ready'}</span></div>
      {canEdit && <form className="inline-form" onSubmit={addRequirement}><input value={newRequirement.title} onChange={e => setNewRequirement(x => ({ ...x, title: e.target.value }))} placeholder="e.g. Valid tax clearance certificate" /><label><input type="checkbox" checked={newRequirement.mandatory} onChange={e => setNewRequirement(x => ({ ...x, mandatory: e.target.checked }))} /> Mandatory</label><button className="secondary" disabled={saving}><Plus size={15}/> Add requirement</button></form>}
      <div className="workspace-list">{requirements.length ? requirements.map(item => <div className="workspace-row" key={item.id}><div className="workspace-row-main"><b>{item.title}</b><span>{item.mandatory ? 'Mandatory' : 'Optional'}</span><input value={item.evidence || ''} onChange={e => setRequirements(xs => xs.map(x => x.id === item.id ? { ...x, evidence: e.target.value } : x))} onBlur={e => void updateRequirement(item, { evidence: e.target.value })} disabled={!canEdit} placeholder="Evidence / document / explanation" /></div><div className="workspace-row-actions"><select value={item.status} onChange={e => void updateRequirement(item, { status: e.target.value as Requirement['status'] })} disabled={!canEdit}><option value="open">Open</option><option value="needs-review">Needs review</option><option value="met">Met</option><option value="missing">Missing</option></select>{canEdit && <button className="icon-btn" aria-label={`Remove requirement ${item.title}`} onClick={() => void deleteRequirement(item)}><Trash2 size={15}/></button>}</div></div>) : <p className="muted">No requirements captured yet. Add the mandatory conditions from the tender documents as you review them.</p>}</div>
    </section>

    <section className="panel">
      <div className="section-title"><div><h3>Bid tasks</h3><p className="muted">{completedTasks}/{tasks.length} complete</p></div></div>
      {canEdit && <form className="form-grid" onSubmit={addTask}><Field label="Task"><input value={newTask.title} onChange={e => setNewTask(x => ({ ...x, title: e.target.value }))} placeholder="e.g. Complete technical response" /></Field><Field label="Owner"><select value={newTask.assigneeId} onChange={e => setNewTask(x => ({ ...x, assigneeId: e.target.value }))}><option value="">Unassigned</option>{users.filter(u => u.active && u.status !== 'Suspended').map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field><Field label="Due"><input type="datetime-local" value={newTask.dueAt} onChange={e => setNewTask(x => ({ ...x, dueAt: e.target.value }))} /></Field><Field label="Priority"><select value={newTask.priority} onChange={e => setNewTask(x => ({ ...x, priority: e.target.value as Task['priority'] }))}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></Field><Field label="Workstream"><select value={newTask.kind} onChange={e => setNewTask(x => ({ ...x, kind: e.target.value as Task['kind'] }))}><option value="technical">Technical</option><option value="financial">Financial</option><option value="submission">Submission</option><option value="internal-review">Internal review</option><option value="other">Other</option></select></Field><div><button className="secondary" disabled={saving}><Plus size={15}/> Add task</button></div></form>}
      <div className="workspace-list">{tasks.length ? tasks.map(item => <div className="workspace-row" key={item.id}><div className="workspace-row-main"><b>{item.title}</b><span>{item.kind.replaceAll('-', ' ')} · {item.priority}</span><small>{item.dueAt ? fmt(item.dueAt) : 'No due date'}</small></div><div className="workspace-row-actions"><select value={item.status} onChange={e => void updateTask(item, { status: e.target.value as Task['status'] })} disabled={!canEdit}><option value="todo">To do</option><option value="in-progress">In progress</option><option value="done">Done</option></select>{canEdit && <button className="icon-btn" aria-label={`Remove task ${item.title}`} onClick={() => void deleteTask(item)}><Trash2 size={15}/></button>}</div></div>) : <p className="muted">No tasks yet. Add the work required to move this bid to submission.</p>}</div>
    </section>
  </div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>;
}
