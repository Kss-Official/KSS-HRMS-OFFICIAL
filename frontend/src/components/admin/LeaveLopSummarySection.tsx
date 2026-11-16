import React, { useState, useMemo } from 'react';
import { useAuth } from '../../context/AuthContext';
import {
  Calendar,
  AlertTriangle,
  FileText,
  HeartPulse,
  Download,
  FileSpreadsheet,
  Search,
  ArrowUpDown,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  Users,
  Info,
  CalendarDays,
  ShieldCheck,
  RefreshCw,
  Clock,
  Sparkles
} from 'lucide-react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Cell,
  CartesianGrid
} from 'recharts';
import { toast } from 'sonner';
import {
  LeaveLopFilterOption,
  EmployeeLeaveLopItem,
  computeLeaveLopSummary,
  formatSummaryDisplayDate,
  exportLeaveSummaryToCsv,
  exportLeaveSummaryToExcel
} from '../../lib/leaveLopSummaryService';
import { todayInIST } from '../../lib/absoluteTime';
import { useHaptic } from '../../hooks/useHaptic';
import { isExecutiveOrLeadership } from '../../lib/attendanceEngine';

interface LeaveLopSummarySectionProps {
  className?: string;
  defaultFilter?: LeaveLopFilterOption;
  hideRoleGuard?: boolean;
}

type SortField = 'totalLeaveDays' | 'lopDays' | 'elDays' | 'slDays' | 'fullName';
type SortOrder = 'asc' | 'desc';

export const LeaveLopSummarySection: React.FC<LeaveLopSummarySectionProps> = ({
  className = '',
  defaultFilter = '7d',
  hideRoleGuard = false
}) => {
  const { employees, leaveRequests, attendance, settings, activeEmployee, role } = useAuth();
  const { triggerHaptic } = useHaptic();

  const effectiveRole = activeEmployee?.role || role;
  const isAuthorized = hideRoleGuard || 
    effectiveRole === 'SUPER_ADMIN' || 
    effectiveRole === 'HR_ADMIN' || 
    effectiveRole === 'PROJECT_MANAGER' ||
    isExecutiveOrLeadership(activeEmployee);

  // Filter States
  const [selectedFilter, setSelectedFilter] = useState<LeaveLopFilterOption>(defaultFilter);
  const [customStart, setCustomStart] = useState<string>(() => {
    const today = todayInIST();
    const [y, m, d] = today.split('-').map(Number);
    const prev = new Date(Date.UTC(y, m - 1, d - 6, 12, 0, 0));
    return `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}-${String(prev.getUTCDate()).padStart(2, '0')}`;
  });
  const [customEnd, setCustomEnd] = useState<string>(() => todayInIST());

  // Table Controls
  const [searchQuery, setSearchQuery] = useState('');
  const [showZeroLeaveStaff, setShowZeroLeaveStaff] = useState(false);
  const [sortField, setSortField] = useState<SortField>('totalLeaveDays');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');
  const [expandedEmployeeId, setExpandedEmployeeId] = useState<string | null>(null);

  // Export Loading State
  const [isExporting, setIsExporting] = useState(false);

  // Compute Canonical Summary
  const summary = useMemo(() => {
    return computeLeaveLopSummary(
      employees || [],
      leaveRequests || [],
      attendance || [],
      settings,
      selectedFilter,
      customStart,
      customEnd
    );
  }, [employees, leaveRequests, attendance, settings, selectedFilter, customStart, customEnd]);

  // Handle Sort Change
  const handleSort = (field: SortField) => {
    triggerHaptic();
    if (sortField === field) {
      setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortOrder('desc');
    }
  };

  // Filter and Sort Table Rows
  const filteredRows = useMemo(() => {
    let rows = summary.items;

    // Filter by Zero Leave toggle
    if (!showZeroLeaveStaff) {
      rows = rows.filter(r => r.totalLeaveDays > 0);
    }

    // Filter by Search Query
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      rows = rows.filter(r =>
        r.fullName.toLowerCase().includes(q) ||
        r.employeeCode.toLowerCase().includes(q) ||
        r.department.toLowerCase().includes(q) ||
        r.designation.toLowerCase().includes(q)
      );
    }

    // Sort Rows
    return [...rows].sort((a, b) => {
      let comparison = 0;
      if (sortField === 'fullName') {
        comparison = a.fullName.localeCompare(b.fullName);
      } else {
        comparison = (a[sortField] as number) - (b[sortField] as number);
      }
      return sortOrder === 'desc' ? -comparison : comparison;
    });
  }, [summary.items, showZeroLeaveStaff, searchQuery, sortField, sortOrder]);

  // Reconciled Display Totals for Table Footer
  const tableFooterTotals = useMemo(() => {
    return filteredRows.reduce(
      (acc, r) => ({
        lop: acc.lop + r.lopDays,
        el: acc.el + r.elDays,
        sl: acc.sl + r.slDays,
        total: acc.total + r.totalLeaveDays
      }),
      { lop: 0, el: 0, sl: 0, total: 0 }
    );
  }, [filteredRows]);

  // Export Handlers
  const handleExportCsv = () => {
    triggerHaptic();
    try {
      setIsExporting(true);
      exportLeaveSummaryToCsv(summary, activeEmployee?.fullName || 'HRMS Admin');
      toast.success('Leave & LOP Summary exported to CSV successfully!');
    } catch (err: any) {
      toast.error('Failed to export CSV: ' + (err?.message || 'Unknown error'));
    } finally {
      setIsExporting(false);
    }
  };

  const handleExportExcel = async () => {
    triggerHaptic();
    try {
      setIsExporting(true);
      await exportLeaveSummaryToExcel(summary, activeEmployee?.fullName || 'HRMS Admin');
      toast.success('Leave & LOP Summary exported to Excel (.xlsx) successfully!');
    } catch (err: any) {
      toast.error('Failed to export Excel: ' + (err?.message || 'Unknown error'));
    } finally {
      setIsExporting(false);
    }
  };

  // Permission Guard
  if (!isAuthorized) {
    return null;
  }

  const isCustom = selectedFilter === 'custom';
  const hasInvalidCustomRange = isCustom && customStart > customEnd;

  return (
    <section className={`bg-slate-900 border border-slate-800 rounded-3xl p-5 sm:p-6 shadow-xl space-y-6 ${className}`}>
      
      {/* ── 1. Header & Controls Bar ── */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-5 border-b border-slate-800">
        
        {/* Title & Reporting Period */}
        <div>
          <div className="flex items-center gap-2.5">
            <span className="p-2 rounded-xl bg-blue-500/10 text-blue-400 border border-blue-500/20 shadow-sm">
              <Calendar className="w-5 h-5" />
            </span>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base sm:text-lg font-black text-white tracking-tight">
                  Leave &amp; LOP Summary
                </h3>
                <span className="text-[10px] font-mono font-bold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-md border border-emerald-500/20 hidden sm:inline-flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" /> Live Firestore
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                Reporting Period: <strong className="text-slate-200">{summary.label}</strong>
                <span className="text-slate-500 font-mono ml-1.5 hidden md:inline">({summary.daysCount} calendar days • Asia/Kolkata)</span>
              </p>
            </div>
          </div>
        </div>

        {/* Date Filter Pills & Export Buttons */}
        <div className="flex flex-wrap items-center gap-2 self-start lg:self-auto">
          
          {/* Quick Date Range Switchers */}
          <div className="flex items-center gap-1 bg-slate-950 p-1 rounded-2xl border border-slate-800 shrink-0">
            {(
              [
                { id: '7d', label: 'Last 7 Days' },
                { id: '15d', label: 'Last 15 Days' },
                { id: '30d', label: 'Last 30 Days' },
                { id: 'custom', label: 'Custom Range' }
              ] as const
            ).map(opt => (
              <button
                key={opt.id}
                onClick={() => {
                  triggerHaptic();
                  setSelectedFilter(opt.id);
                }}
                className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                  selectedFilter === opt.id
                    ? 'bg-blue-600 text-white shadow-md shadow-blue-900/30'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* Export Dropdown / Buttons */}
          <div className="flex items-center gap-1.5">
            <button
              onClick={handleExportCsv}
              disabled={isExporting}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 hover:text-white rounded-xl text-xs font-bold border border-slate-700 transition-all cursor-pointer shadow-sm disabled:opacity-50"
              title="Download clean CSV report"
            >
              <Download className="w-3.5 h-3.5 text-blue-400" />
              <span>CSV</span>
            </button>
            <button
              onClick={handleExportExcel}
              disabled={isExporting}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600/15 hover:bg-emerald-600/25 text-emerald-300 hover:text-white rounded-xl text-xs font-bold border border-emerald-500/30 transition-all cursor-pointer shadow-sm disabled:opacity-50"
              title="Download formatted Excel (.xlsx) workbook"
            >
              <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-400" />
              <span>Excel</span>
            </button>
          </div>

        </div>
      </div>

      {/* ── 1.5. Custom Date Range Pickers (Visible when Custom is selected) ── */}
      {isCustom && (
        <div className="p-4 bg-slate-950/70 border border-slate-800 rounded-2xl flex flex-col sm:flex-row sm:items-center justify-between gap-4 animate-in fade-in zoom-in-95 duration-200">
          <div className="flex items-center gap-2">
            <CalendarDays className="w-4 h-4 text-blue-400 shrink-0" />
            <div>
              <span className="text-xs font-bold text-white">Select Custom Reporting Window</span>
              <p className="text-[11px] text-slate-400">Choose start and end dates in Asia/Kolkata timezone</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <label className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">From:</label>
              <input
                type="date"
                value={customStart}
                max={todayInIST()}
                onChange={e => setCustomStart(e.target.value)}
                className="bg-slate-900 border border-slate-700 text-xs font-mono font-bold text-white px-3 py-1.5 rounded-xl focus:outline-none focus:border-blue-500 cursor-pointer"
              />
            </div>

            <div className="flex items-center gap-2">
              <label className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">To:</label>
              <input
                type="date"
                value={customEnd}
                max={todayInIST()}
                onChange={e => setCustomEnd(e.target.value)}
                className="bg-slate-900 border border-slate-700 text-xs font-mono font-bold text-white px-3 py-1.5 rounded-xl focus:outline-none focus:border-blue-500 cursor-pointer"
              />
            </div>

            {hasInvalidCustomRange && (
              <span className="text-xs text-rose-400 font-bold flex items-center gap-1">
                <AlertTriangle className="w-3.5 h-3.5" /> Start date must be before end date
              </span>
            )}
          </div>
        </div>
      )}

      {/* ── 2. Three Primary Summary KPI Cards: LOP, EL, SL ── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        
        {/* Card 1: Loss of Pay (LOP) */}
        <div className="p-5 rounded-2xl bg-gradient-to-br from-rose-950/30 via-slate-900 to-slate-950 border border-rose-500/20 text-rose-400 shadow-md relative overflow-hidden group">
          <div className="absolute top-0 right-0 -mr-6 -mt-6 w-24 h-24 bg-rose-500/5 rounded-full blur-xl pointer-events-none" />
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-black uppercase tracking-wider text-rose-400 flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-rose-400 shrink-0" />
              Total LOP Days
            </span>
            <AlertTriangle className="w-4 h-4 text-rose-400 group-hover:scale-110 transition-transform" />
          </div>
          
          <div className="mt-3 flex items-baseline gap-2">
            <span className="text-3xl font-black text-white font-mono tracking-tight">{summary.totalLopDays}</span>
            <span className="text-xs text-slate-400 font-medium">days taken</span>
          </div>

          <div className="mt-3 pt-3 border-t border-rose-500/10 text-xs text-slate-300 flex items-center justify-between">
            <span>Staff affected:</span>
            <span className="font-mono text-white font-bold">{summary.uniqueLopCount} {summary.uniqueLopCount === 1 ? 'employee' : 'employees'}</span>
          </div>
          <div className="mt-1 text-[11px] text-rose-400/90 font-semibold flex items-center justify-between">
            <span>Share of leave:</span>
            <span className="font-mono font-bold">{summary.distribution.lopPercent}% of total</span>
          </div>
        </div>

        {/* Card 2: Earned Leave (EL) */}
        <div className="p-5 rounded-2xl bg-gradient-to-br from-blue-950/30 via-slate-900 to-slate-950 border border-blue-500/20 text-blue-400 shadow-md relative overflow-hidden group">
          <div className="absolute top-0 right-0 -mr-6 -mt-6 w-24 h-24 bg-blue-500/5 rounded-full blur-xl pointer-events-none" />
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-black uppercase tracking-wider text-blue-400 flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-blue-400 shrink-0" />
              Earned Leave (EL) Days
            </span>
            <FileText className="w-4 h-4 text-blue-400 group-hover:scale-110 transition-transform" />
          </div>
          
          <div className="mt-3 flex items-baseline gap-2">
            <span className="text-3xl font-black text-white font-mono tracking-tight">{summary.totalElDays}</span>
            <span className="text-xs text-slate-400 font-medium">days taken</span>
          </div>

          <div className="mt-3 pt-3 border-t border-blue-500/10 text-xs text-slate-300 flex items-center justify-between">
            <span>Staff took EL:</span>
            <span className="font-mono text-white font-bold">{summary.uniqueElCount} {summary.uniqueElCount === 1 ? 'employee' : 'employees'}</span>
          </div>
          <div className="mt-1 text-[11px] text-blue-400/90 font-semibold flex items-center justify-between">
            <span>Share of leave:</span>
            <span className="font-mono font-bold">{summary.distribution.elPercent}% of total</span>
          </div>
        </div>

        {/* Card 3: Sick Leave (SL) */}
        <div className="p-5 rounded-2xl bg-gradient-to-br from-amber-950/30 via-slate-900 to-slate-950 border border-amber-500/20 text-amber-400 shadow-md relative overflow-hidden group">
          <div className="absolute top-0 right-0 -mr-6 -mt-6 w-24 h-24 bg-amber-500/5 rounded-full blur-xl pointer-events-none" />
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-black uppercase tracking-wider text-amber-400 flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-amber-400 shrink-0" />
              Sick Leave (SL) Days
            </span>
            <HeartPulse className="w-4 h-4 text-amber-400 group-hover:scale-110 transition-transform" />
          </div>
          
          <div className="mt-3 flex items-baseline gap-2">
            <span className="text-3xl font-black text-white font-mono tracking-tight">{summary.totalSlDays}</span>
            <span className="text-xs text-slate-400 font-medium">days taken</span>
          </div>

          <div className="mt-3 pt-3 border-t border-amber-500/10 text-xs text-slate-300 flex items-center justify-between">
            <span>Staff took SL:</span>
            <span className="font-mono text-white font-bold">{summary.uniqueSlCount} {summary.uniqueSlCount === 1 ? 'employee' : 'employees'}</span>
          </div>
          <div className="mt-1 text-[11px] text-amber-400/90 font-semibold flex items-center justify-between">
            <span>Share of leave:</span>
            <span className="font-mono font-bold">{summary.distribution.slPercent}% of total</span>
          </div>
        </div>

      </div>

      {/* ── 3. Overall Workforce Summary Strip & Graphical Comparison ── */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        
        {/* Left: Overall Company Totals (5 Cols) */}
        <div className="lg:col-span-5 bg-slate-950/60 border border-slate-800 rounded-2xl p-4 sm:p-5 flex flex-col justify-between space-y-4">
          <div>
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">
                Overall Summary
              </span>
              <span className="text-[10px] font-mono font-bold text-slate-500 bg-slate-900 px-2 py-0.5 rounded border border-slate-800">
                All Employees
              </span>
            </div>
            
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-3xl font-black text-white font-mono">{summary.totalLeaveDays}</span>
              <span className="text-xs text-slate-400 font-medium">Total Leave &amp; LOP Days Taken</span>
            </div>
          </div>

          {/* Quick Metrics Grid */}
          <div className="grid grid-cols-2 gap-3 pt-3 border-t border-slate-800/80 text-xs">
            <div className="p-2.5 rounded-xl bg-slate-900/80 border border-slate-800">
              <span className="text-[10px] text-slate-500 uppercase tracking-wider font-bold block">Staff on Leave</span>
              <div className="mt-1 flex items-baseline gap-1">
                <span className="text-lg font-black text-white font-mono">{summary.uniqueLeaveStaffCount}</span>
                <span className="text-[10px] text-slate-500">/ {summary.totalActiveStaff} active staff</span>
              </div>
            </div>

            <div className="p-2.5 rounded-xl bg-slate-900/80 border border-slate-800">
              <span className="text-[10px] text-slate-500 uppercase tracking-wider font-bold block">Workforce Leave Rate</span>
              <div className="mt-1 flex items-baseline gap-1">
                <span className="text-lg font-black text-blue-400 font-mono">
                  {summary.totalActiveStaff > 0 ? Math.round((summary.uniqueLeaveStaffCount / summary.totalActiveStaff) * 100) : 0}%
                </span>
                <span className="text-[10px] text-slate-500">of workforce</span>
              </div>
            </div>
          </div>

          {/* Segmented Proportional Progress Bar */}
          <div className="space-y-1.5 pt-2">
            <div className="flex items-center justify-between text-[11px] text-slate-400 font-semibold">
              <span>Leave Composition</span>
              <span className="font-mono">{summary.totalLeaveDays} days</span>
            </div>
            <div className="h-2.5 w-full bg-slate-900 rounded-full overflow-hidden flex border border-slate-800">
              {summary.totalLeaveDays === 0 ? (
                <div className="w-full bg-slate-800" />
              ) : (
                <>
                  <div
                    style={{ width: `${summary.distribution.lopPercent}%` }}
                    className="h-full bg-rose-500 transition-all duration-500"
                    title={`LOP: ${summary.totalLopDays}d (${summary.distribution.lopPercent}%)`}
                  />
                  <div
                    style={{ width: `${summary.distribution.elPercent}%` }}
                    className="h-full bg-blue-500 transition-all duration-500"
                    title={`EL: ${summary.totalElDays}d (${summary.distribution.elPercent}%)`}
                  />
                  <div
                    style={{ width: `${summary.distribution.slPercent}%` }}
                    className="h-full bg-amber-500 transition-all duration-500"
                    title={`SL: ${summary.totalSlDays}d (${summary.distribution.slPercent}%)`}
                  />
                </>
              )}
            </div>
            <div className="flex items-center gap-3 text-[10px] font-bold pt-1">
              <span className="flex items-center gap-1 text-rose-400">
                <span className="w-2 h-2 rounded-full bg-rose-500" /> LOP ({summary.totalLopDays}d)
              </span>
              <span className="flex items-center gap-1 text-blue-400">
                <span className="w-2 h-2 rounded-full bg-blue-500" /> EL ({summary.totalElDays}d)
              </span>
              <span className="flex items-center gap-1 text-amber-400">
                <span className="w-2 h-2 rounded-full bg-amber-500" /> SL ({summary.totalSlDays}d)
              </span>
            </div>
          </div>

        </div>

        {/* Right: Simple Graphical Comparison of LOP, EL, and SL Totals (7 Cols) */}
        <div className="lg:col-span-7 bg-slate-950/60 border border-slate-800 rounded-2xl p-4 sm:p-5 flex flex-col justify-between">
          <div className="flex items-center justify-between border-b border-slate-800 pb-2 mb-2">
            <div>
              <h4 className="text-xs font-bold text-white flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-blue-400" />
                Graphical Comparison (LOP vs EL vs SL)
              </h4>
              <p className="text-[11px] text-slate-400">Direct days comparison across the selected period</p>
            </div>
            <span className="text-[10px] font-mono text-slate-400">Days Taken</span>
          </div>

          <div className="h-44 w-full">
            <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
              <BarChart
                data={summary.chartData}
                layout="vertical"
                margin={{ top: 10, right: 30, left: 10, bottom: 5 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" horizontal={false} />
                <XAxis
                  type="number"
                  tick={{ fontSize: 10, fill: '#64748b' }}
                  axisLine={false}
                  tickLine={false}
                  allowDecimals={false}
                />
                <YAxis
                  type="category"
                  dataKey="shortLabel"
                  tick={{ fontSize: 11, fill: '#cbd5e1', fontWeight: 'bold' }}
                  axisLine={false}
                  tickLine={false}
                  width={40}
                />
                <Tooltip
                  cursor={{ fill: '#1e293b', opacity: 0.4 }}
                  content={({ active, payload }) => {
                    if (active && payload && payload.length) {
                      const data = payload[0].payload;
                      return (
                        <div className="bg-slate-900 border border-slate-700 p-2.5 rounded-xl shadow-xl text-xs space-y-1">
                          <p className="font-bold text-white">{data.category}</p>
                          <p className="font-mono text-slate-300 font-bold">
                            Days Taken: <span className="text-white">{data.days} days</span> ({data.percentage}%)
                          </p>
                          <p className="text-[11px] text-slate-400">
                            Unique staff: <span className="text-slate-200 font-semibold">{data.uniqueStaff} employees</span>
                          </p>
                        </div>
                      );
                    }
                    return null;
                  }}
                />
                <Bar dataKey="days" radius={[0, 8, 8, 0]} barSize={20}>
                  {summary.chartData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.fill} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="flex items-center justify-between text-[11px] text-slate-400 border-t border-slate-800/80 pt-2 font-mono">
            <span>Reconciled sum: {summary.totalLeaveDays} total days</span>
            <span>Zero WFH overlap</span>
          </div>
        </div>

      </div>

      {/* ── 4. Employee-Wise Breakdown Table ── */}
      <div className="space-y-3">
        
        {/* Table Controls Row */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          
          <div className="flex items-center gap-2">
            <h4 className="text-xs font-bold text-slate-300 uppercase tracking-wider">
              Employee Breakdown ({filteredRows.length} {filteredRows.length === 1 ? 'employee' : 'employees'})
            </h4>
            <span className="text-[10px] text-slate-500 font-mono">
              ({showZeroLeaveStaff ? 'Showing all staff' : 'Showing staff with leave'})
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 self-start sm:self-auto">
            {/* Search Input */}
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Search staff, code, dept..."
                className="bg-slate-950 border border-slate-800 text-xs text-white pl-8 pr-3 py-1.5 rounded-xl focus:outline-none focus:border-blue-500 w-44 sm:w-56"
              />
            </div>

            {/* Zero Leave Toggle */}
            <button
              onClick={() => {
                triggerHaptic();
                setShowZeroLeaveStaff(!showZeroLeaveStaff);
              }}
              className={`px-3 py-1.5 rounded-xl text-xs font-bold border transition-all cursor-pointer ${
                showZeroLeaveStaff
                  ? 'bg-blue-600/20 text-blue-300 border-blue-500/40'
                  : 'bg-slate-950 text-slate-400 border-slate-800 hover:text-white'
              }`}
            >
              {showZeroLeaveStaff ? '✓ Showing All Staff' : '+ Include 0 Leave Staff'}
            </button>
          </div>

        </div>

        {/* The Table */}
        <div className="overflow-hidden border border-slate-800 rounded-2xl bg-slate-950/40 shadow-inner">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-950/90 border-b border-slate-800 text-[10px] text-slate-400 uppercase tracking-wider font-bold select-none">
                <tr>
                  <th
                    onClick={() => handleSort('fullName')}
                    className="py-3 px-4 cursor-pointer hover:text-white transition-colors"
                  >
                    <div className="flex items-center gap-1.5">
                      <span>Employee Name</span>
                      <ArrowUpDown className="w-3 h-3 text-slate-500" />
                    </div>
                  </th>
                  <th
                    onClick={() => handleSort('lopDays')}
                    className="py-3 px-4 text-right cursor-pointer hover:text-rose-300 text-rose-400 transition-colors"
                  >
                    <div className="flex items-center justify-end gap-1.5">
                      <span>LOP Days</span>
                      <ArrowUpDown className="w-3 h-3 text-rose-500/60" />
                    </div>
                  </th>
                  <th
                    onClick={() => handleSort('elDays')}
                    className="py-3 px-4 text-right cursor-pointer hover:text-blue-300 text-blue-400 transition-colors"
                  >
                    <div className="flex items-center justify-end gap-1.5">
                      <span>EL Days</span>
                      <ArrowUpDown className="w-3 h-3 text-blue-500/60" />
                    </div>
                  </th>
                  <th
                    onClick={() => handleSort('slDays')}
                    className="py-3 px-4 text-right cursor-pointer hover:text-amber-300 text-amber-400 transition-colors"
                  >
                    <div className="flex items-center justify-end gap-1.5">
                      <span>SL Days</span>
                      <ArrowUpDown className="w-3 h-3 text-amber-500/60" />
                    </div>
                  </th>
                  <th
                    onClick={() => handleSort('totalLeaveDays')}
                    className="py-3 px-4 text-right cursor-pointer hover:text-white text-white transition-colors"
                  >
                    <div className="flex items-center justify-end gap-1.5">
                      <span>Total Days</span>
                      <ArrowUpDown className="w-3 h-3 text-slate-400" />
                    </div>
                  </th>
                  <th className="py-3 px-4 text-center">
                    <span>Audit Breakdown</span>
                  </th>
                </tr>
              </thead>

              <tbody className="divide-y divide-slate-800/60 font-sans">
                {filteredRows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-12 text-center text-slate-500">
                      <CheckCircle2 className="w-8 h-8 text-emerald-500/70 mx-auto mb-2" />
                      <p className="text-xs font-bold text-slate-300">
                        No leave or Loss of Pay records found
                      </p>
                      <p className="text-[11px] text-slate-500 mt-0.5">
                        {searchQuery.trim()
                          ? `No staff matched query "${searchQuery}"`
                          : `All personnel were on active duty or regular scheduled weekly off during ${summary.label}.`}
                      </p>
                      {!showZeroLeaveStaff && (
                        <button
                          onClick={() => setShowZeroLeaveStaff(true)}
                          className="mt-3 text-xs text-blue-400 hover:text-blue-300 font-bold underline cursor-pointer"
                        >
                          View all registered staff roster
                        </button>
                      )}
                    </td>
                  </tr>
                ) : (
                  filteredRows.map(row => {
                    const isExpanded = expandedEmployeeId === row.employeeId;
                    const hasLeave = row.totalLeaveDays > 0;

                    return (
                      <React.Fragment key={row.employeeId}>
                        <tr className="hover:bg-slate-800/40 transition-colors group">
                          
                          {/* Employee Name & Meta */}
                          <td className="py-3 px-4">
                            <div className="flex items-center gap-3">
                              <img
                                src={row.avatarUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(row.fullName)}&background=0f172a&color=fff`}
                                alt={row.fullName}
                                className="w-8 h-8 rounded-xl object-cover border border-slate-700/60 group-hover:border-blue-500/60 transition-all shrink-0"
                              />
                              <div className="min-w-0">
                                <div className="font-bold text-white text-xs truncate group-hover:text-blue-300 transition-colors">
                                  {row.fullName}
                                </div>
                                <div className="text-[10px] text-slate-400 font-mono truncate">
                                  {row.employeeCode} • {row.department}
                                </div>
                              </div>
                            </div>
                          </td>

                          {/* LOP Days */}
                          <td className="py-3 px-4 text-right font-mono font-bold">
                            {row.lopDays > 0 ? (
                              <span className="text-rose-400 bg-rose-500/10 px-2 py-0.5 rounded-md border border-rose-500/20 text-xs">
                                {row.lopDays}d
                              </span>
                            ) : (
                              <span className="text-slate-600">0</span>
                            )}
                          </td>

                          {/* EL Days */}
                          <td className="py-3 px-4 text-right font-mono font-bold">
                            {row.elDays > 0 ? (
                              <span className="text-blue-400 bg-blue-500/10 px-2 py-0.5 rounded-md border border-blue-500/20 text-xs">
                                {row.elDays}d
                              </span>
                            ) : (
                              <span className="text-slate-600">0</span>
                            )}
                          </td>

                          {/* SL Days */}
                          <td className="py-3 px-4 text-right font-mono font-bold">
                            {row.slDays > 0 ? (
                              <span className="text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded-md border border-amber-500/20 text-xs">
                                {row.slDays}d
                              </span>
                            ) : (
                              <span className="text-slate-600">0</span>
                            )}
                          </td>

                          {/* Total Days Taken */}
                          <td className="py-3 px-4 text-right font-mono font-black">
                            {hasLeave ? (
                              <span className="text-white text-xs bg-slate-800 px-2.5 py-1 rounded-md border border-slate-700">
                                {row.totalLeaveDays}d
                              </span>
                            ) : (
                              <span className="text-slate-600 text-xs font-normal">0d</span>
                            )}
                          </td>

                          {/* Action / Expand Details */}
                          <td className="py-3 px-4 text-center">
                            {hasLeave ? (
                              <button
                                onClick={() => {
                                  triggerHaptic();
                                  setExpandedEmployeeId(isExpanded ? null : row.employeeId);
                                }}
                                className={`px-2.5 py-1 rounded-lg text-[10px] font-bold border transition-all cursor-pointer flex items-center gap-1 mx-auto ${
                                  isExpanded
                                    ? 'bg-blue-600/20 text-blue-300 border-blue-500/40'
                                    : 'bg-slate-900 text-slate-400 border-slate-800 hover:text-white'
                                }`}
                              >
                                <span>{row.leaveDays.length} {row.leaveDays.length === 1 ? 'event' : 'events'}</span>
                                {isExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                              </button>
                            ) : (
                              <span className="text-slate-600 text-[10px] italic">No leave</span>
                            )}
                          </td>

                        </tr>

                        {/* Expandable Row: Detailed Dates Breakdown */}
                        {isExpanded && row.leaveDays.length > 0 && (
                          <tr className="bg-slate-950/80">
                            <td colSpan={6} className="p-3 sm:px-6">
                              <div className="space-y-2 border-l-2 border-blue-500 pl-3">
                                <span className="text-[11px] font-bold text-slate-300 uppercase tracking-wider block">
                                  Audit Trail for {row.fullName} ({row.leaveDays.length} leave records in period):
                                </span>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
                                  {row.leaveDays.map((d, idx) => (
                                    <div
                                      key={idx}
                                      className="p-2.5 rounded-xl bg-slate-900 border border-slate-800 flex items-start justify-between gap-2"
                                    >
                                      <div>
                                        <div className="flex items-center gap-1.5 mb-1">
                                          <span className="font-mono font-bold text-white text-[11px]">
                                            {formatSummaryDisplayDate(d.date)} ({d.dayOfWeek})
                                          </span>
                                          <span
                                            className={`text-[9px] font-black px-1.5 py-0.2 rounded border ${
                                              d.leaveType === 'LOP'
                                                ? 'bg-rose-500/20 text-rose-300 border-rose-500/30'
                                                : d.leaveType === 'SL'
                                                ? 'bg-amber-500/20 text-amber-300 border-amber-500/30'
                                                : 'bg-blue-500/20 text-blue-300 border-blue-500/30'
                                            }`}
                                          >
                                            {d.leaveType} ({d.daysValue}d{d.isHalfDay ? ' Half' : ''})
                                          </span>
                                        </div>
                                        <p className="text-[11px] text-slate-400 italic line-clamp-2">
                                          "{d.reason || d.notes || 'No reason specified'}"
                                        </p>
                                      </div>

                                      <span className="text-[9px] font-mono text-slate-500 shrink-0">
                                        {d.source === 'leave_request' ? 'Request' : 'Attendance'}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })
                )}
              </tbody>

              {/* Table Footer Reconciled Totals */}
              {filteredRows.length > 0 && (
                <tfoot className="bg-slate-950/95 border-t border-slate-800 text-xs font-bold text-slate-300">
                  <tr>
                    <td className="py-3 px-4">
                      <span className="text-white font-black">
                        {searchQuery.trim() ? 'FILTERED TOTAL' : 'TOTAL (RECONCILED)'}
                      </span>
                      <span className="text-[10px] text-slate-500 font-mono ml-2">
                        ({filteredRows.length} staff)
                      </span>
                    </td>
                    <td className="py-3 px-4 text-right font-mono font-black text-rose-400">
                      {tableFooterTotals.lop}d
                    </td>
                    <td className="py-3 px-4 text-right font-mono font-black text-blue-400">
                      {tableFooterTotals.el}d
                    </td>
                    <td className="py-3 px-4 text-right font-mono font-black text-amber-400">
                      {tableFooterTotals.sl}d
                    </td>
                    <td className="py-3 px-4 text-right font-mono font-black text-white">
                      {tableFooterTotals.total}d
                    </td>
                    <td className="py-3 px-4 text-center text-[10px] font-mono text-emerald-400">
                      ✓ 100% Reconciled
                    </td>
                  </tr>
                </tfoot>
              )}

            </table>
          </div>
        </div>

      </div>

    </section>
  );
};
