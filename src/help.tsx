import { Modal, Button } from './components';
import { msg, t } from './i18n';
import type { ModalName } from './pages';

type Step = { title: string; text: string; action: string; page?: string; modal?: ModalName };
const steps: Step[] = [
  { title: msg('Set up your business'), text: msg('Create your own workspace (the demo is fictional), then fill in your business details: name, address, VAT number, invoice numbering and an optional logo.'), action: msg('Open business settings'), modal: 'settings' },
  { title: msg('Add a client and a project'), text: msg('Choose an hourly rate or a fixed price. Tick “Costs complete” only once all direct costs of the project are recorded.'), action: msg('Open projects'), page: 'Projects' },
  { title: msg('Record all your time'), text: msg('Add hours or start a timer. Include unpaid preparation, meetings and aftercare: they count toward the real result per hour.'), action: msg('Open time'), page: 'Time' },
  { title: msg('Review and approve'), text: msg('Time under “Needs review” is not counted until you approve it. A timer’s elapsed time is only a suggestion.'), action: msg('Open time'), page: 'Time' },
  { title: msg('Turn work into an invoice'), text: msg('Create a draft from approved billable time. A draft reserves that time so it cannot be invoiced twice; delete the draft to release it.'), action: msg('Open invoices'), page: 'Invoices' },
  { title: msg('Issue, print and get paid'), text: msg('Issuing gives the invoice its number and freezes it. Print or save it as PDF from your browser. Record payments, including part payments; corrections use a credit note.'), action: msg('Open invoices'), page: 'Invoices' },
  { title: msg('Add costs and receipts'), text: msg('Record direct project costs with the original receipt. A project’s contribution stays “Unknown” until its costs are confirmed complete.'), action: msg('Open expenses'), page: 'Expenses' },
  { title: msg('Compare and back up'), text: msg('Overview shows what each project earns per worked hour. Download a backup regularly and keep a copy somewhere other than this computer.'), action: msg('Open workspace & backup'), modal: 'workspace' },
];
const terms = [
  [msg('Contribution'), msg('Revenue minus direct project costs, before general overhead and income tax.')],
  [msg('Per worked hour'), msg('Contribution divided by all approved hours, billable and non-billable.')],
  [msg('Revenue'), msg('Issued invoices minus credit notes. Payments reduce what is outstanding; they are not extra revenue.')],
  [msg('Your data'), msg('Records stay in a local database on this device. Nothing is sent to a server or AI service.')],
];

/** Plain-language walkthrough of the complete flow, reachable from the header on every page. */
export function HelpGuide({ onClose, navigate, open }: { onClose: () => void; navigate: (page: string) => void; open: (modal: ModalName) => void }) {
  const go = (step: Step) => { onClose(); if (step.page) navigate(step.page); if (step.modal) open(step.modal); };
  return <Modal title={t('How Billable works')} subtitle={t('Your first complete flow, step by step.')} onClose={onClose} wide><div className="help-body">
    <ol className="help-steps">{steps.map((step, index) => <li key={step.title}><span className="help-number">{index + 1}</span><div><h3>{t(step.title)}</h3><p>{t(step.text)}</p><button className="text-link" onClick={() => go(step)}>{t(step.action)}</button></div></li>)}</ol>
    <h3 className="help-terms-title">{t('Good to know')}</h3>
    <dl className="help-terms">{terms.map(([term, text]) => <div key={term}><dt>{t(term)}</dt><dd>{t(text)}</dd></div>)}</dl>
    <div className="form-actions"><Button onClick={onClose}>{t('Got it')}</Button></div></div>
  </Modal>;
}
