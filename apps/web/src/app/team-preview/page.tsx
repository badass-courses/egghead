import type { Metadata } from "next";
import { Container } from "@egghead/ui/container";

import "./team-preview.css";

export const metadata: Metadata = {
  title: "Team learning | egghead",
  description: "See what your team is learning with egghead.",
};

type Member = {
  name: string;
  initials: string;
  focus: string;
  topic: string;
  lessons: number;
  learningDays: number;
  lastLearning: string;
  status: "learning" | "quiet" | "invited";
};

const MEMBERS = [
  {
    name: "Maya Chen",
    initials: "MC",
    focus: "Effective Runtime Type Checks with Zod",
    topic: "TypeScript",
    lessons: 9,
    learningDays: 4,
    lastLearning: "Aug 26",
    status: "learning",
  },
  {
    name: "Jordan Kim",
    initials: "JK",
    focus: "Scripting Local Language Models with Ollama and the Vercel AI SDK",
    topic: "GenAI",
    lessons: 7,
    learningDays: 3,
    lastLearning: "Aug 25",
    status: "learning",
  },
  {
    name: "Nia Okafor",
    initials: "NO",
    focus: "Build a Twitter Clone with the Next.js App Router and Supabase",
    topic: "Next.js",
    lessons: 8,
    learningDays: 3,
    lastLearning: "Aug 24",
    status: "learning",
  },
  {
    name: "Luis Santos",
    initials: "LS",
    focus: "Modern Redux with Redux Toolkit and TypeScript",
    topic: "React",
    lessons: 6,
    learningDays: 2,
    lastLearning: "Aug 23",
    status: "learning",
  },
  {
    name: "Sam Rivera",
    initials: "SR",
    focus: "Fundamental Next.js API and Patterns",
    topic: "Next.js",
    lessons: 9,
    learningDays: 4,
    lastLearning: "Aug 22",
    status: "learning",
  },
  {
    name: "Taylor Brooks",
    initials: "TB",
    focus: "Getting Started with Supabase Local Dev",
    topic: "Supabase",
    lessons: 5,
    learningDays: 2,
    lastLearning: "Aug 20",
    status: "learning",
  },
  {
    name: "Devin Park",
    initials: "DP",
    focus: "No published completions in this period",
    topic: "—",
    lessons: 0,
    learningDays: 0,
    lastLearning: "Jul 10",
    status: "quiet",
  },
  {
    name: "Alex Morgan",
    initials: "AM",
    focus: "Invitation not accepted",
    topic: "—",
    lessons: 0,
    learningDays: 0,
    lastLearning: "Not started",
    status: "invited",
  },
] as const satisfies readonly Member[];

const TOPICS = [
  { name: "TypeScript", learners: 5, lessons: 19, width: "100%", tone: "yolk" },
  { name: "Next.js", learners: 4, lessons: 15, width: "79%", tone: "sky" },
  { name: "React", learners: 3, lessons: 9, width: "47%", tone: "sage" },
  { name: "GenAI", learners: 2, lessons: 7, width: "37%", tone: "rust" },
] as const;

const WEEKLY_ACTIVITY = [
  { label: "Jul 27", lessons: 5 },
  { label: "Aug 3", lessons: 8 },
  { label: "Aug 10", lessons: 11 },
  { label: "Aug 17", lessons: 9 },
  { label: "Aug 24", lessons: 11 },
] as const;

function Avatar({ member }: { member: Member }) {
  return (
    <span aria-label={member.name} className="team-avatar" title={member.name}>
      {member.initials}
    </span>
  );
}

function statusLabel(status: Member["status"]) {
  if (status === "learning") return "Learning";
  if (status === "invited") return "Invited";
  return "No activity in period";
}

function ActivityChart() {
  const maxLessons = Math.max(...WEEKLY_ACTIVITY.map((week) => week.lessons));

  return (
    <section className="team-trend" aria-labelledby="trend-heading">
      <header className="team-section-heading">
        <div>
          <h3 id="trend-heading">A steady learning rhythm</h3>
          <p>Completed lessons by week</p>
        </div>
        <p className="team-trend-total">
          <strong>44</strong> lessons · <strong>3</strong> courses
        </p>
      </header>

      <div className="team-bars">
        {WEEKLY_ACTIVITY.map((week) => (
          <div className="team-bar-column" key={week.label}>
            <span className="team-bar-value">{week.lessons}</span>
            <span
              aria-label={`${week.lessons} lessons completed in the week of ${week.label}`}
              className="team-bar"
              style={{ height: `${Math.round((week.lessons / maxLessons) * 100)}%` }}
            />
            <span className="team-bar-label">{week.label}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function SkillsInMotion() {
  return (
    <section className="team-skills" aria-labelledby="skills-heading">
      <header className="team-section-heading">
        <div>
          <h3 id="skills-heading">Skills in motion</h3>
          <p>TypeScript is the most shared topic across the team.</p>
        </div>
        <span className="team-change">9 more lessons than the prior 30 days</span>
      </header>

      <div className="team-topic-list">
        {TOPICS.map((topic) => (
          <div className="team-topic" key={topic.name}>
            <strong>{topic.name}</strong>
            <div className="team-topic-track" aria-hidden>
              <span data-tone={topic.tone} style={{ width: topic.width }} />
            </div>
            <span>
              {topic.learners} people · {topic.lessons} lessons
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function TeamRoster() {
  return (
    <section className="team-roster" aria-labelledby="roster-heading">
      <header className="team-section-heading">
        <div>
          <h3 id="roster-heading">What teammates are learning</h3>
          <p>Published completion activity, not login frequency.</p>
        </div>
        <p className="team-roster-summary">6 learning · 1 quiet · 1 invited</p>
      </header>

      <div className="team-table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Teammate</th>
              <th scope="col">Learning now</th>
              <th scope="col">Last learning</th>
              <th scope="col">Lessons</th>
              <th scope="col">Days</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {MEMBERS.map((member) => (
              <tr key={member.name}>
                <th scope="row">
                  <Avatar member={member} />
                  <span>{member.name}</span>
                </th>
                <td data-label="Learning now">
                  <strong>{member.focus}</strong>
                  <small>{member.topic}</small>
                </td>
                <td data-label="Last learning">{member.lastLearning}</td>
                <td className="team-number" data-label="Lessons">
                  {member.lessons}
                </td>
                <td className="team-number" data-label="Learning days">
                  {member.learningDays}
                </td>
                <td data-label="Status">
                  <span className="team-status" data-status={member.status}>
                    {statusLabel(member.status)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function TeamPreviewPage() {
  return (
    <main className="team-preview-main">
      <Container as="div" className="team-preview-shell" size="wide">
        <header className="team-page-header">
          <div>
            <h1>Acme Engineering</h1>
            <p>See what your team is learning and where momentum is building.</p>
          </div>
          <dl className="team-header-facts">
            <div>
              <dt>Period</dt>
              <dd>Jul 28–Aug 26, 2026</dd>
            </div>
            <div>
              <dt>Seats</dt>
              <dd>8 of 10 assigned</dd>
            </div>
          </dl>
        </header>

        <p className="team-demo-note">
          Preview data is illustrative. Course and topic labels come from the public egghead
          catalog.
        </p>

        <article className="team-dashboard">
          <section className="team-overview" aria-labelledby="overview-heading">
            <div>
              <h2 id="overview-heading">TypeScript and Next.js are becoming shared team skills.</h2>
              <p>
                <strong>6 of 8 teammates</strong> learned on <strong>12 different days</strong>,
                completing <strong>44 lessons</strong> during this period.
              </p>
            </div>
            <p className="team-overview-note">
              Participation is up from the previous period, with a steady rhythm rather than one
              completion spike.
            </p>
          </section>

          <ActivityChart />
          <SkillsInMotion />
          <TeamRoster />
        </article>
      </Container>
    </main>
  );
}
