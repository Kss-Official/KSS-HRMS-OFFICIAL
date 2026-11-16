import React from 'react';
import { LeaveLopSummarySection } from './LeaveLopSummarySection';

/**
 * Backward compatibility wrapper forwarding to the production LeaveLopSummarySection.
 */
export const LeaveHistorySummarySection: React.FC = () => {
  return <LeaveLopSummarySection />;
};
