import { mutateDb } from '../store.js';
import { id, now, hashPassword } from '../helpers.js';

const ADMIN_EMAIL = 'admin@tunaxa.com';
const ADMIN_NAME = 'Tunaxa Admin';
const ADMIN_PASSWORD = 'tunaxa2024';

const owners = ['Amina Salhi', 'Karim Ben Salah', 'Lina Trabelsi', 'Mehdi Jlassi'];

const users = [
  { name: ADMIN_NAME, email: ADMIN_EMAIL, password: hashPassword(ADMIN_PASSWORD), role: 'admin', workspaceId: id('ws') },
];

const contacts = [
  { name: 'Alice Miller', role: 'Procurement Manager', company: 'Northwind Traders', email: 'alice.miller@northwind.com', phone: '+1-212-555-0173', owner: owners[0] },
  { name: 'Bob Carter', role: 'Operations Director', company: 'Northwind Traders', email: 'bob.carter@northwind.com', phone: '+1-212-555-0184', owner: owners[0] },
  { name: 'Daniel Smith', role: 'CTO', company: 'Acme Corporation', email: 'daniel.smith@acme.com', phone: '+1-312-555-0197', owner: owners[1] },
  { name: 'Emily Johnson', role: 'VP Sales', company: 'Acme Corporation', email: 'emily.johnson@acme.com', phone: '+1-312-555-0109', owner: owners[1] },
  { name: 'Hans Weber', role: 'Head of Procurement', company: 'Globex Logistics', email: 'hans.weber@globex.io', phone: '+49-30-555-0142', owner: owners[3] },
  { name: 'Greta Hoffmann', role: 'Supply Chain Lead', company: 'Globex Logistics', email: 'greta.hoffmann@globex.io', phone: '+49-30-555-0176', owner: owners[3] },
  { name: 'Samir Ben Ali', role: 'CFO', company: 'Initech Systems', email: 'samir.benali@initech.io', phone: '+1-415-555-0128', owner: owners[2] },
  { name: 'Linda Park', role: 'Product Manager', company: 'Initech Systems', email: 'linda.park@initech.io', phone: '+1-415-555-0139', owner: owners[2] },
  { name: 'Sofia Nielsen', role: 'R&D Director', company: 'Umbrella Biotech', email: 'sofia.nielsen@umbrellalabs.com', phone: '+45-33-555-0114', owner: owners[0] },
  { name: 'Jonas Berg', role: 'Lab Manager', company: 'Umbrella Biotech', email: 'jonas.berg@umbrellalabs.com', phone: '+45-33-555-0125', owner: owners[0] },
  { name: 'Tony Gilmore', role: 'COO', company: 'Stark Industries', email: 'tony.gilmore@starkindustries.com', phone: '+1-516-555-0168', owner: owners[1] },
  { name: 'Pepper Fortier', role: 'Head of Strategy', company: 'Stark Industries', email: 'pepper.fortier@starkindustries.com', phone: '+1-516-555-0147', owner: owners[1] },
  { name: 'Lucius Fox', role: 'SVP Finance', company: 'Wayne Enterprises', email: 'lucius.fox@wayne.com', phone: '+1-212-555-0170', owner: owners[3] },
  { name: 'Diana Prince', role: 'Director of Operations', company: 'Wayne Enterprises', email: 'diana.prince@wayne.com', phone: '+1-212-555-0195', owner: owners[3] },
  { name: 'Gustavo Fermin', role: 'VP Engineering', company: 'Hooli Global', email: 'gustavo.fermin@hooli.io', phone: '+353-1-555-0134', owner: owners[2] },
  { name: 'Nelson Bighetti', role: 'Sales Lead', company: 'Hooli Global', email: 'nelson.bighetti@hooli.io', phone: '+353-1-555-0189', owner: owners[2] },
  { name: 'Richard Hendricks', role: 'CEO', company: 'Pied Piper Networks', email: 'richard.hendricks@piedpiper.net', phone: '+1-650-555-0124', owner: owners[0] },
  { name: 'Dinesh Chugtai', role: 'CTO', company: 'Pied Piper Networks', email: 'dinesh.chugtai@piedpiper.net', phone: '+1-650-555-0158', owner: owners[0] },
  { name: 'Phil Schmitz', role: 'Purchasing Manager', company: 'Soylent Foods', email: 'phil.schmitz@soylent.co', phone: '+1-416-555-0132', owner: owners[3] },
  { name: 'Rachel Green', role: 'Director of Operations', company: 'Soylent Foods', email: 'rachel.green@soylent.co', phone: '+1-416-555-0157', owner: owners[3] },
];

const leads = [
  { name: 'Olivia Martinez', company: 'Brightpath Analytics', email: 'olivia.martinez@brightpath.io', phone: '+1-415-555-0177', source: 'Website', status: 'New', value: 12000, owner: owners[0] },
  { name: 'Liam Chen', company: 'Peak Fitness', email: 'liam.chen@peakfit.co', phone: '+1-604-555-0119', source: 'Referral', status: 'Qualified', value: 8500, owner: owners[1] },
  { name: 'Nora Al-Farsi', company: 'Meridian Travels', email: 'nora.alfarsi@meridiantravels.com', phone: '+971-4-555-0144', source: 'LinkedIn', status: 'Contacted', value: 22000, owner: owners[2] },
  { name: 'Ethan Brooks', company: 'Vertex Capital', email: 'ethan.brooks@vertexcap.com', phone: '+1-646-555-0165', source: 'Trade show', status: 'Nurture', value: 26000, owner: owners[3] },
  { name: 'Aisha Okafor', company: 'Lagos Fresh Foods', email: 'aisha.okafor@lagosfresh.ng', phone: '+234-1-555-0133', source: 'Referral', status: 'New', value: 4500, owner: owners[0] },
  { name: 'Marco Rossi', company: 'Milano Textiles', email: 'marco.rossi@milanotextiles.it', phone: '+39-02-555-0188', source: 'Email campaign', status: 'Contacted', value: 9800, owner: owners[3] },
  { name: 'Julia Novak', company: 'Prague Cloud Solutions', email: 'julia.novak@praguecloud.cz', phone: '+420-2-555-0126', source: 'Website', status: 'Qualified', value: 15000, owner: owners[2] },
  { name: 'Tom Whitmore', company: 'Whitmore & Co Legal', email: 'tom.whitmore@whitmorelaw.com', phone: '+1-202-555-0149', source: 'Cold call', status: 'New', value: 3400, owner: owners[1] },
  { name: 'Fatima Zahraoui', company: 'Atlas Mining', email: 'fatima.zahraoui@atlasmining.ma', phone: '+212-5-555-0138', source: 'LinkedIn', status: 'Nurture', value: 28000, owner: owners[3] },
  { name: 'David Kowalski', company: 'Baltic Shipping', email: 'david.kowalski@balticship.pl', phone: '+48-22-555-0151', source: 'Trade show', status: 'Qualified', value: 12000, owner: owners[0] },
  { name: 'Elena Petrova', company: 'SibSoft', email: 'elena.petrova@sibsoft.ru', phone: '+7-495-555-0146', source: 'Ads', status: 'Lost', value: 6000, owner: owners[2] },
  { name: 'James O\u2019Neill', company: 'Cork Craft Couriers', email: 'james.oneill@corkcraft.ie', phone: '+353-21-555-0129', source: 'Referral', status: 'Contacted', value: 7800, owner: owners[1] },
  { name: 'Chris Andrade', company: 'BlueSky Aviation', email: 'chris.andrade@blueskyaviation.com', phone: '+1-305-555-0156', source: 'Website', status: 'New', value: 19000, owner: owners[2] },
  { name: 'Yuki Tanaka', company: 'Kyoto Robotics', email: 'yuki.tanaka@kyotorobotics.jp', phone: '+81-75-555-0172', source: 'Partner', status: 'Qualified', value: 32000, owner: owners[0] },
  { name: 'Ahmed Belhadj', company: 'Carthage Pharma', email: 'ahmed.belhadj@carthagepharma.tn', phone: '+216-71-555-0161', source: 'Email campaign', status: 'Nurture', value: 11000, owner: owners[3] },
];

const companies = [
  { name: 'Northwind Traders', industry: 'Retail', website: 'https://northwind.com', country: 'United States', employees: 320, owner: owners[0] },
  { name: 'Acme Corporation', industry: 'Manufacturing', website: 'https://acme.com', country: 'United States', employees: 1200, owner: owners[1] },
  { name: 'Globex Logistics', industry: 'Logistics', website: 'https://globex.io', country: 'Germany', employees: 85, owner: owners[3] },
  { name: 'Initech Systems', industry: 'Software', website: 'https://initech.io', country: 'United States', employees: 45, owner: owners[2] },
  { name: 'Umbrella Biotech', industry: 'Biotechnology', website: 'https://umbrellalabs.com', country: 'Denmark', employees: 210, owner: owners[0] },
  { name: 'Stark Industries', industry: 'Aerospace', website: 'https://starkindustries.com', country: 'United States', employees: 5200, owner: owners[1] },
  { name: 'Wayne Enterprises', industry: 'Conglomerate', website: 'https://wayne.com', country: 'United States', employees: 9800, owner: owners[3] },
  { name: 'Hooli Global', industry: 'Technology', website: 'https://hooli.io', country: 'Ireland', employees: 640, owner: owners[2] },
  { name: 'Pied Piper Networks', industry: 'Technology', website: 'https://piedpiper.net', country: 'United States', employees: 28, owner: owners[0] },
  { name: 'Soylent Foods', industry: 'Food & Beverage', website: 'https://soylent.co', country: 'Canada', employees: 150, owner: owners[3] },
];

const deals = [
  { title: 'Enterprise CRM rollout', company: 'Northwind Traders', value: 48000, stage: 'proposal', owner: owners[1], closeDate: '2026-11-15' },
  { title: 'Cloud migration package', company: 'Acme Corporation', value: 65000, stage: 'negotiation', owner: owners[0], closeDate: '2026-10-30' },
  { title: 'Logistics automation suite', company: 'Globex Logistics', value: 39000, stage: 'qualified', owner: owners[3], closeDate: '2026-12-05' },
  { title: 'Support contract renewal', company: 'Initech Systems', value: 18000, stage: 'negotiation', owner: owners[2], closeDate: '2026-11-20' },
  { title: 'Biotech data platform', company: 'Umbrella Biotech', value: 72000, stage: 'won', owner: owners[0], closeDate: '2026-09-10' },
  { title: 'Defense ERP expansion', company: 'Stark Industries', value: 120000, stage: 'new', owner: owners[1], closeDate: '2027-01-15' },
  { title: 'Conglomerate integration', company: 'Wayne Enterprises', value: 95000, stage: 'proposal', owner: owners[3], closeDate: '2026-12-18' },
  { title: 'Startup growth plan', company: 'Pied Piper Networks', value: 24000, stage: 'won', owner: owners[2], closeDate: '2026-08-25' },
];

const tasks = [
  { title: 'Follow up on Olivia Martinez proposal', owner: owners[0], priority: 'High', status: 'Open', dueDate: '2026-09-25' },
  { title: 'Prepare demo for Acme cloud migration', owner: owners[1], priority: 'Urgent', status: 'In progress', dueDate: '2026-09-21' },
  { title: 'Send contract to Globex Logistics', owner: owners[3], priority: 'Medium', status: 'Open', dueDate: '2026-09-23' },
  { title: 'Renew Initech support agreement', owner: owners[2], priority: 'High', status: 'In progress', dueDate: '2026-09-30' },
  { title: 'Update pipeline forecast for Q4', owner: owners[0], priority: 'Medium', status: 'Open', dueDate: '2026-09-27' },
  { title: 'Call Aisha Okafor to qualify', owner: owners[0], priority: 'Low', status: 'Completed', dueDate: '2026-09-11' },
  { title: 'Onboard new lead from roadmap webinar', owner: owners[3], priority: 'Medium', status: 'Completed', dueDate: '2026-09-09' },
  { title: 'Chase invoice for Stark expansion', owner: owners[1], priority: 'High', status: 'Open', dueDate: '2026-09-28' },
  { title: 'Review Wayne Enterprises pricing', owner: owners[3], priority: 'Urgent', status: 'In progress', dueDate: '2026-09-22' },
  { title: 'Clean up stale leads in Nurture', owner: owners[2], priority: 'Low', status: 'Completed', dueDate: '2026-09-14' },
];

const activities = [
  { title: 'Call with Alice Miller', type: 'Call', contact: 'alice.miller@northwind.com', notes: 'Discussed quarterly pricing; agreed to send revised quote.', date: '2026-09-12' },
  { title: 'Email to Daniel Smith', type: 'Email', contact: 'daniel.smith@acme.com', notes: 'Sent POC overview and security whitepaper.', date: '2026-09-15' },
  { title: 'Meeting with Umbrella Biotech', type: 'Meeting', contact: 'sofia.nielsen@umbrellalabs.com', notes: 'Walked through the data platform demo with R&D.', date: '2026-09-17' },
  { title: 'Lead score update', type: 'Lead Score', contact: 'julia.novak@praguecloud.cz', notes: 'Reached Sales Qualified threshold via engagement scoring.', date: '2026-09-18' },
  { title: 'Follow-up note', type: 'Note', contact: 'tom.whitmore@whitmorelaw.com', notes: 'Left voicemail; will try again Thursday morning.', date: '2026-09-16' },
];

const PREFIXES = {
  users: 'usr',
  contacts: 'contact',
  leads: 'lead',
  companies: 'company',
  deals: 'deal',
  tasks: 'task',
  activities: 'activity',
};

const KEY_FN = {
  users: (r) => r.email,
  contacts: (r) => r.email,
  leads: (r) => r.email || r.name,
  companies: (r) => r.name,
  deals: (r) => r.title,
  tasks: (r) => r.title,
  activities: (r) => r.notes || r.title,
};

const MARKER = { tasks: 'seed', activities: 'seed' };

function seedResource(db, resource, rows, extra = {}) {
  const list = db[resource] || [];
  const added = [];
  let skipped = 0;
  for (const data of rows) {
    const key = KEY_FN[resource](data);
    const existingKey = (r) => {
      if (MARKER[resource] && r.source !== MARKER[resource]) return undefined;
      return KEY_FN[resource](r);
    };
    const exists = key != null && list.some((r) => existingKey(r) === key);
    if (exists) {
      skipped += 1;
      continue;
    }
    const createdAt = now();
    const record = {
      id: id(PREFIXES[resource]),
      ...data,
      ...extra,
      createdAt,
      updatedAt: createdAt,
    };
    list.unshift(record);
    added.push(record);
  }
  if (added.length) db[resource] = list;
  return { added: added.length, skipped };
}

const stats = await mutateDb((db) => {
  const seedSources = { tasks: { source: 'seed' }, activities: { source: 'seed' } };
  const result = {};
  result.users = seedResource(db, 'users', users);
  result.contacts = seedResource(db, 'contacts', contacts);
  result.leads = seedResource(db, 'leads', leads);
  result.companies = seedResource(db, 'companies', companies);
  result.deals = seedResource(db, 'deals', deals);
  result.tasks = seedResource(db, 'tasks', tasks, seedSources.tasks);
  result.activities = seedResource(db, 'activities', activities, seedSources.activities);
  return result;
});

for (const [resource, { added, skipped }] of Object.entries(stats)) {
  console.log(`${resource.padEnd(10)} added ${added}  skipped ${skipped}`);
}
console.log(`admin login: ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}`);