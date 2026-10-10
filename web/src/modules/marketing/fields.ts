import { type FieldSpec } from "../../components/records/types";

export const campaignFields: FieldSpec[] = [
  { key: "name", label: "Campaign name", required: true },
  {
    key: "channel",
    label: "Channel",
    type: "select",
    options: ["Email", "SMS", "Social", "Multi-channel"],
  },
  {
    key: "status",
    label: "Status",
    type: "select",
    options: ["Draft", "Active", "Paused", "Completed"],
  },
  { key: "target", label: "Target audience", type: "number" },
  { key: "reached", label: "Reached", type: "number" },
  { key: "leads", label: "Leads generated", type: "number" },
  { key: "startDate", label: "Start date", type: "date" },
  { key: "endDate", label: "End date", type: "date" },
  { key: "description", label: "Description", type: "textarea" },
];

export const emailListFields: FieldSpec[] = [
  { key: "name", label: "List name", required: true },
  { key: "subscribers", label: "Subscribers", type: "number" },
  {
    key: "status",
    label: "Status",
    type: "select",
    options: ["Draft", "Active", "Archived"],
  },
  { key: "description", label: "Description", type: "textarea" },
];

export const marketingEmailFields: FieldSpec[] = [
  { key: "name", label: "Email name", required: true },
  { key: "subject", label: "Subject line" },
  { key: "list", label: "Audience list" },
  {
    key: "status",
    label: "Status",
    type: "select",
    options: ["Draft", "Scheduled", "Sent", "Archived"],
  },
  { key: "recipients", label: "Recipients", type: "number" },
  { key: "opens", label: "Opens", type: "number" },
  { key: "clicks", label: "Clicks", type: "number" },
  { key: "conversions", label: "Conversions", type: "number" },
  { key: "sendDate", label: "Send date", type: "date" },
];
