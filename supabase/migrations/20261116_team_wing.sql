-- Team Wing: private offices 11-15. Comped (team) Growth members fill 11+ first,
-- paying Growth members fill 1-10 first. Applied to Supabase Nov 16, 2026.
-- See assign_desk() in Supabase for the full function; private_office_count set to 15.
update public.office_settings set value = '15' where key = 'private_office_count';
