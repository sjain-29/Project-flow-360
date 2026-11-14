/**
 * First-run data: default roles, departments and settings. Written once when the
 * system is initialised (by the bootstrap administrator in Firebase mode, or
 * automatically in demo mode). Nothing here is operational or sample data.
 */
import { DEFAULT_DEPARTMENTS, defaultRoles, defaultSettings } from '../config/app-config.js';

export function baseSeed() {
  return {
    roles: defaultRoles(),
    departments: Object.fromEntries(DEFAULT_DEPARTMENTS.map(([id, name], i) => [id, { name, active: true, order: i }])),
    settings: defaultSettings(),
  };
}

export function newUserRecord({ username, displayName, roleId, departmentId, departments, scope, authUid, mustChangePassword = true, now }) {
  const depts = departments || { [departmentId]: true };
  return {
    username, displayName, roleId,
    departmentId: departmentId || Object.keys(depts)[0],
    departments: depts,
    scope: scope || (roleId === 'super_admin' ? 'all' : 'selected'),
    active: true,
    authUid,
    mustChangePassword,
    createdAt: now,
  };
}

/** Demo accounts — one per role / department, so every permission path can be tried. */
export const DEMO_PASSWORD = 'demo1234';
export const DEMO_USERS = [
  ['admin', 'Asha Admin (demo)', 'super_admin', 'project_management', 'all'],
  ['pm', 'Pranav PM (demo)', 'project_manager', 'project_management', 'selected'],
  ['planning_head', 'Pooja Planning Head (demo)', 'department_head', 'planning', 'all'],
  ['planning', 'Piyush Planning (demo)', 'department_user', 'planning', 'all'],
  ['sourcing', 'Sana Sourcing (demo)', 'department_user', 'sourcing', 'all'],
  ['accounts', 'Arjun Accounts (demo)', 'department_user', 'accounts', 'all'],
  ['stores', 'Sunil Stores (demo)', 'department_user', 'stores', 'all'],
  ['stores_head', 'Smita Stores Head (demo)', 'department_head', 'stores', 'all'],
  ['logistics', 'Lata Logistics (demo)', 'department_user', 'logistics', 'all'],
  ['travel', 'Tarun Travel Desk (demo)', 'department_user', 'travel_desk', 'all'],
  ['developer', 'Dev Developer (demo)', 'department_user', 'development', 'all'],
  ['tester', 'Tina Tester (demo)', 'department_user', 'testing', 'all'],
  ['test_head', 'Tejas Test Head (demo)', 'department_head', 'testing', 'all'],
  ['viewer', 'Vikram Viewer (demo)', 'viewer', 'administration', 'selected'],
];
