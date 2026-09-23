import crypto from "node:crypto";
import { mutateDb } from "../store.js";

const id = (prefix) => `${prefix}_${crypto.randomUUID()}`;
const now = () => new Date().toISOString();

export const AUTOMATION_PLAYBOOKS = [
  {
    name: "New lead follow-up (Marketing playbook)",
    description:
      "Automation playbook: when a lead is created, assign an owner and create a task to follow up next business day.",
    event: "lead.created",
    filter: { field: "status", op: "in", value: ["New", "Nurture"] },
    actions: [
      {
        type: "task",
        title: "Follow up on new lead {{name}}",
        owner: "{{owner}}",
        priority: "High",
        dueDate: "",
      },
    ],
  },
  {
    name: "Welcome email to new contacts",
    description:
      "Automation playbook: welcome new contacts as soon as they are added to the CRM.",
    event: "contact.created",
    filter: { field: "email", op: "isSet" },
    actions: [
      {
        type: "email",
        to: "{{email}}",
        subject: "Welcome to Tunaxa",
        body: "Hi {{name}},\n\nWelcome! We are glad to have you on board.",
      },
    ],
  },
  {
    name: "Risky deal alert",
    description:
      "Automation playbook: alert the owner when a deal slips back to negotiation with no close date.",
    event: "deal.updated",
    filter: { field: "stage", op: "in", value: ["negotiation", "proposal"] },
    actions: [
      {
        type: "task",
        title: "Review risky deal {{title}}",
        owner: "{{owner}}",
        priority: "Urgent",
        dueDate: "",
      },
    ],
  },
  {
    name: "Form submission auto-responder",
    description:
      "Automation playbook: instantly respond to form submissions captured by the CRM.",
    event: "form.submitted",
    filter: { field: "email", op: "isSet" },
    actions: [
      {
        type: "email",
        to: "{{email}}",
        subject: "Thank you for your submission",
        body: "Hi {{name}},\n\nThanks for getting in touch. We will get back to you shortly.",
      },
    ],
  },
  {
    name: "Low-stock reorder reminder",
    description:
      "Automation playbook: flag products near reorder point so the team restocks in time.",
    event: "product.updated",
    filter: { field: "stock", op: "isSet" },
    actions: [
      {
        type: "task",
        title: "Reorder low-stock product {{name}}",
        owner: "{{owner}}",
        priority: "High",
        dueDate: "",
      },
    ],
  },
  {
    name: "Invoice overdue reminder",
    description:
      "Automation playbook: remind customers about unpaid invoices before they fall behind.",
    event: "invoice.created",
    filter: { field: "status", op: "neq", value: "paid" },
    actions: [
      {
        type: "email",
        to: "{{customerEmail}}",
        subject: "Invoice reminder",
        body: "Hi {{customerName}},\n\nJust a reminder about invoice {{number}} due {{dueDate}}.",
      },
    ],
  },
  {
    name: "Task completion notification",
    description:
      "Automation playbook: log an activity whenever a team member completes a task.",
    event: "task.completed",
    filter: {},
    actions: [
      {
        type: "activity",
        title: "Task completed: {{title}}",
        subtype: "Task",
        notes: "Marked {{title}} as completed.",
      },
    ],
  },
  {
    name: "Webhook event logging",
    description:
      "Automation playbook: log an activity whenever an inbound webhook delivers new data.",
    event: "webhook.received",
    filter: {},
    actions: [
      {
        type: "activity",
        title: "Webhook delivery received: {{endpoint.name}}",
        subtype: "Webhook",
        notes: "Inbound payload delivered to {{endpoint.name}}.",
      },
    ],
  },
];

export async function seedPlaybooks() {
  await mutateDb((db) => {
    if (!Array.isArray(db.workflows)) db.workflows = [];
    for (const playbook of AUTOMATION_PLAYBOOKS) {
      const existing = db.workflows.find((w) => w.name === playbook.name);
      if (!existing) {
        const stamp = now();
        db.workflows.push({
          id: id("workflow"),
          ...playbook,
          enabled: false,
          createdAt: stamp,
          createdBy: "System",
          updatedAt: stamp,
        });
      }
    }
  });
}
