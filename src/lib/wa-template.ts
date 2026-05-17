import type { Job } from './db/schema';

export const renderForWhatsApp = (job: Job): string => {
  const lines = [
    `*${job.role}* @ ${job.company}`,
    `${job.location}${job.comp ? ` · ${job.comp}` : ''}`,
    '',
    job.blurb,
    '',
    `Apply: ${job.applyWeb}`,
  ];
  if (job.applyApi) lines.push(`API: ${job.applyApi}`);
  lines.push(`Contact: ${job.contactEmail}`);
  lines.push(`More: https://genaicommunity.ai/jobs/${job.id}`);
  return lines.join('\n');
};
