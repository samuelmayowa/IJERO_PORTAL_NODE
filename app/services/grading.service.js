
// Default 5-point scale; override via DB or env if needed
const DEFAULT_POINTS = { A:5, B:4, C:3, D:2, E:1, F:0 };

export function gradeToPoint(grade){
  if(!grade) return 0;
  const g = (''+grade).trim().toUpperCase();
  return DEFAULT_POINTS[g] ?? 0;
}

export function computeGPA(courses){
  // courses: [{units:number, grade:string}]
  let tu = 0, tp = 0;
  for(const c of courses){
    const u = Number(c.units)||0;
    const gp = gradeToPoint(c.grade);
    tu += u;
    tp += u * gp;
  }
  const gpa = tu>0 ? (tp/tu) : 0;
  return { totalUnits: tu, totalPoints: tp, gpa: Number(gpa.toFixed(2)) };
}
