import { useEffect, useRef, type ReactNode } from 'react';
import { ArrowUpRight, X, Plus, type LucideIcon } from 'lucide-react';

export function Button({ children, variant = 'primary', icon: Icon, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'quiet' | 'danger'; icon?: LucideIcon }) {
  return <button {...props} className={`button ${variant} ${props.className || ''}`}>{Icon && <Icon size={16} strokeWidth={1.8} />}{children}</button>;
}
export function Empty({ title, text, action, onAction, icon: Icon = Plus }: { title: string; text: string; action?: string; onAction?: () => void; icon?: LucideIcon }) {
  return <div className="empty"><div className="empty-icon"><Icon size={28} strokeWidth={1.3} /></div><h3>{title}</h3><p>{text}</p>{action && <Button onClick={onAction} icon={Plus}>{action}</Button>}</div>;
}
export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'green' | 'blue' | 'amber' | 'red' | 'neutral' }) { return <span className={`badge ${tone}`}>{children}</span>; }
export function Field({ label, children, hint, className = '' }: { label: string; children: ReactNode; hint?: string; className?: string }) {
  return <label className={`field ${className}`}><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}
export function Check({ children, ...props }: React.InputHTMLAttributes<HTMLInputElement> & { children: ReactNode }) { return <label className="check"><input type="checkbox" {...props} /><span>{children}</span></label>; }
export function PageHeader({ eyebrow, title, text, children }: { eyebrow: string; title: string; text: string; children?: ReactNode }) {
  return <header className="page-header"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{text}</p></div><div className="header-actions">{children}</div></header>;
}
export function PanelHeader({ title, text, action, onAction }: { title: string; text?: string; action?: string; onAction?: () => void }) { return <div className="panel-header"><div><h2>{title}</h2>{text && <p>{text}</p>}</div>{action && <button className="text-link" onClick={onAction}>{action}<ArrowUpRight size={14}/></button>}</div>; }
export function Modal({ title, subtitle, children, onClose, wide = false }: { title: string; subtitle?: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    // Start at a marked element or the first field; never on the header's close button.
    const root = element.current;
    (root?.querySelector<HTMLElement>('[data-autofocus]') ?? root?.querySelector<HTMLElement>('input:not([type="checkbox"]):not([type="hidden"]):not(:disabled), select:not(:disabled), textarea:not(:disabled)') ?? root?.querySelector<HTMLElement>('.modal-header ~ * button:not(:disabled)'))?.focus();
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key !== 'Tab') return;
      const nodes = [...(element.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]') || [])];
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', listener);
    return () => { document.body.style.overflow = previousOverflow; document.removeEventListener('keydown', listener); previous?.focus(); };
  }, [onClose]);
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><div ref={element} role="dialog" aria-modal="true" aria-label={title} className={`modal ${wide ? 'wide' : ''}`}><div className="modal-header"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button onClick={onClose} className="icon-button" aria-label="Close dialog"><X size={20}/></button></div>{children}</div></div>;
}
