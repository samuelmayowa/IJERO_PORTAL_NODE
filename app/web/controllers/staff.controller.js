
// export const dashboard=(req,res)=>res.render('pages/staff-dashboard');
export const transcriptsMenu=(req,res)=>res.render('pages/staff-transcripts');
export const resultsMenu=(req,res)=>res.render('pages/staff-results');
export const recordsMenu=(req,res)=>res.render('pages/staff-records');

export const dashboard = (req, res) => {
  const user = req.session?.user || null;
  const sidebar = [
    { label: 'Dashboard', href: '/staff/dashboard', icon: 'fas fa-tachometer-alt', active: true },
    { label: 'Student Academic Records', href: '/records', icon: 'fas fa-table' },
    { label: 'Result Computation', href: '/results', icon: 'fas fa-calculator' },
    { label: 'Generate Transcript', href: '/transcripts/generate', icon: 'far fa-file-alt' },
    { label: 'View / Download Transcript', href: '/transcripts/view', icon: 'far fa-file-pdf' },
    { label: 'Send Transcript', href: '/transcripts/send', icon: 'fas fa-paper-plane' }
  ];

  res.render('pages/staff-dashboard', {
    title: 'Staff Dashboard',
    pageTitle: 'Dashboard',
    role: user?.role,
    user,
    sidebar,
    // Optional: seed chart data (you can remove to use defaults)
    performanceData: {
      labels: ['Jan','Feb','Mar','Apr','May','Jun','Jul'],
      area:  [28,48,40,19,86,27,90],
      donut: [40,30,30],
      line:  [10,20,30,40,50,60,70]
    }
  });
};



