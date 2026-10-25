import { useCallback, useEffect, useRef, useState } from 'react';
import type { DshLauncherState } from '../../shared/dsh-launcher';
import type { DshInstalledSkill } from '../../shared/dsh-marketplace';
import { useT } from '../i18n';
import { Button } from '../ui';
import type { LauncherRunRequest } from './DshLauncher';
import { InstanceManagementTarget } from './InstanceManagementTarget';

export function InstanceSkillControls({ state, instanceId, run, disabled = false }: {
  readonly state: DshLauncherState; readonly instanceId: string; readonly run: LauncherRunRequest; readonly disabled?: boolean;
}) {
  const t = useT(); const [inventory, setInventory] = useState<{ instanceId: string; skills: DshInstalledSkill[] }>({ instanceId: '', skills: [] }); const [loading, setLoading] = useState(false);
  const skills = inventory.instanceId === instanceId ? inventory.skills : [];
  const ticket = useRef(0); const instance = state.instances.find(item => item.id === instanceId);
  const revision = state.operations.filter(operation => operation.instanceId === instanceId && operation.kind.startsWith('skill.') && operation.status !== 'running').map(operation => `${operation.id}:${operation.status}`).join('|');
  const locked = disabled || !instance || ['starting', 'stopping'].includes(instance.status) || state.operations.some(operation => operation.status === 'running' && operation.instanceId === instanceId);
  const load = useCallback(async () => {
    const request = ++ticket.current; setLoading(true);
    try {
      const response = await run({ type: 'skill.list', instanceId });
      if (request === ticket.current && response.ok && response.installedSkills) setInventory({ instanceId, skills: response.installedSkills });
    } finally { if (request === ticket.current) setLoading(false); }
  }, [instanceId, run]);
  useEffect(() => {
    const requests = ticket; const timer = setTimeout(() => { void load(); }, 0);
    return () => { clearTimeout(timer); requests.current++; };
  }, [load, revision]);
  const mutate = async (skill: DshInstalledSkill, remove: boolean) => {
    if (locked) return;
    const response = await run(remove ? { type: 'skill.remove', instanceId, name: skill.name } : { type: 'skill.toggle', instanceId, name: skill.name, enabled: !skill.enabled });
    if (response.ok && !response.operationId) await load();
  };
  return <section className="launcher-card launcher-installed-skills" data-installed-skills={instanceId}>
    <div className="launcher-card-heading"><div><h2>{t('launcher.installedSkills')}</h2><p>{t('launcher.skillManageNote')}</p></div><Button disabled={loading || disabled} iconName="refresh" onClick={() => void load()} size="sm" variant="quiet">{t('launcher.refresh')}</Button></div>
    <InstanceManagementTarget state={state} instanceId={instanceId} />
    {skills.length ? skills.map(skill => <div className="launcher-installed-skill" data-installed-skill={skill.name} key={`${skill.enabled}:${skill.name}`}><div><strong>{skill.name}</strong><p>{skill.description}</p><span>{t(skill.enabled ? 'launcher.skillEnabled' : 'launcher.skillDisabled')} · {t(skill.repository ? 'launcher.skillManaged' : 'launcher.skillLocalSource')}</span>{skill.repository ? <span>{skill.repository}{skill.commit ? ` · ${skill.commit.slice(0, 12)}` : ''}{skill.sourcePath ? ` · ${skill.sourcePath}` : ''}</span> : null}<code title={skill.path}>{skill.path}</code></div><div className="launcher-actions"><Button disabled={locked} onClick={() => void mutate(skill, false)} size="sm" variant="quiet">{t(skill.enabled ? 'launcher.disableSkill' : 'launcher.enableSkill')}</Button><Button disabled={locked} iconName="trash" onClick={() => void mutate(skill, true)} size="sm" variant="quiet">{t('launcher.removeSkill')}</Button></div></div>) : <p className="launcher-help">{t(loading ? 'launcher.loadingSkills' : 'launcher.noInstalledSkills')}</p>}
  </section>;
}
