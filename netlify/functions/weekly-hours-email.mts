// netlify/functions/weekly-hours-email.mts
//
// Runs every Sunday evening and emails a summary of:
//   - Kelli's hours logged per project (client) this week
//   - Emily's hours + business expenses for the week, and what she's owed
//
// Reads from the SAME "app_state" table the app itself uses (id/data rows:
// "clients", "entries", "weeklyHours", "weeklyExpenses"), so this always
// matches exactly what's in the app.
//
// SETUP:
// 1. npm install   (installs @supabase/supabase-js, resend, @netlify/functions)
// 2. In Netlify (Site settings > Environment variables) add:
//      SUPABASE_URL               = (your Supabase project URL, Project Settings > API)
//      SUPABASE_SERVICE_ROLE_KEY  = (the SERVICE ROLE key from Supabase, NOT the publishable key — see walkthrough)
//      RESEND_API_KEY             = (from resend.com)
//      NOTIFY_EMAIL                = kelliamis86@gmail.com
// 3. netlify.toml already has the Sunday schedule set.

import type { Config } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";

const HOURLY_RATE = 45;

function getMonday(d: Date) {
  const date = new Date(d);
  const day = date.getDay(); // 0 = Sunday
  const diff = (day + 6) % 7;
  date.setDate(date.getDate() - diff);
  date.setHours(0, 0, 0, 0);
  return date;
}

function isoDate(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function addDays(d: Date, n: number) {
  const nd = new Date(d);
  nd.setDate(nd.getDate() + n);
  return nd;
}

function esc(s: unknown) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string)
  );
}

function fmt1(n: number) {
  return (n || 0).toFixed(1);
}
function fmt2(n: number) {
  return (n || 0).toFixed(2);
}

export default async () => {
  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
  const resend = new Resend(process.env.RESEND_API_KEY!);

  const monday = getMonday(new Date());
  const mondayISO = isoDate(monday);
  const sundayISO = isoDate(addDays(monday, 6));

  const { data: rows, error } = await supabase
    .from("app_state")
    .select("id,data")
    .in("id", ["clients", "entries", "weeklyHours", "weeklyExpenses"]);

  if (error) {
    console.error("Supabase fetch error:", error);
    return new Response("Failed to fetch data: " + error.message, { status: 500 });
  }

  const byId: Record<string, any> = {};
  (rows || []).forEach((r: any) => {
    byId[r.id] = r.data;
  });

  const clients: any[] = byId.clients || [];
  const entries: any[] = byId.entries || [];
  const weeklyHours: Record<string, any> = byId.weeklyHours || {};
  const weeklyExpenses: Record<string, any> = byId.weeklyExpenses || {};

  // ---- Kelli's hours by project, this week ----
  const clientName = (id: string) =>
    clients.find((c: any) => c.id === id)?.name || "Unknown project";

  const hoursByProject: Record<string, number> = {};
  entries
    .filter((e: any) => e.person === "kelli" && e.date >= mondayISO && e.date <= sundayISO)
    .forEach((e: any) => {
      const name = clientName(e.clientId);
      hoursByProject[name] = (hoursByProject[name] || 0) + Number(e.hours || 0);
    });

  // ---- Emily's hours + expenses, this week ----
  const week = weeklyHours[mondayISO] || {};
  const emilyTotalHours = Object.values(week).reduce(
    (sum: number, day: any) => sum + (parseFloat(day?.hours) || 0),
    0
  );
  const exp = weeklyExpenses[mondayISO] || {};
  const emilyExpenseTotal = parseFloat(exp?.amount) || 0;
  const emilyOwed = emilyTotalHours * HOURLY_RATE + emilyExpenseTotal;

  // ---- Build email ----
  const projectRows =
    Object.entries(hoursByProject)
      .sort((a, b) => b[1] - a[1])
      .map(
        ([name, hrs]) =>
          `<tr><td style="padding:6px 12px;">${esc(name)}</td><td style="padding:6px 12px;text-align:right;">${fmt1(hrs)} hrs</td></tr>`
      )
      .join("") ||
    `<tr><td colspan="2" style="padding:6px 12px;color:#888;">No entries logged this week</td></tr>`;

  const html = `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
      <h2 style="margin-bottom:4px;">Style Studio Hours</h2>
      <p style="color:#666;margin-top:0;">Week of ${mondayISO} – ${sundayISO}</p>

      <h3>Kelli's Hours by Project</h3>
      <table style="width:100%;border-collapse:collapse;">
        ${projectRows}
      </table>

      <h3 style="margin-top:24px;">Emily's Week</h3>
      <table style="width:100%;border-collapse:collapse;">
        <tr><td style="padding:6px 12px;">Total hours</td><td style="padding:6px 12px;text-align:right;">${fmt1(emilyTotalHours)} hrs</td></tr>
        <tr><td style="padding:6px 12px;">Business expenses</td><td style="padding:6px 12px;text-align:right;">$${fmt2(emilyExpenseTotal)}</td></tr>
        <tr style="font-weight:bold;border-top:2px solid #333;">
          <td style="padding:6px 12px;">Total owed</td>
          <td style="padding:6px 12px;text-align:right;">$${fmt2(emilyOwed)}</td>
        </tr>
      </table>
    </div>
  `;

  await resend.emails.send({
    from: "Style Studio Hours <onboarding@resend.dev>", // swap for your own verified domain once you have one
    to: process.env.NOTIFY_EMAIL!,
    subject: `Weekly Hours Summary — ${mondayISO} to ${sundayISO}`,
    html,
  });

  return new Response("Weekly hours email sent");
};

export const config: Config = {
  schedule: "0 2 * * 1", // Monday 02:00 UTC ≈ Sunday 8-9pm Central, depending on daylight saving
};
