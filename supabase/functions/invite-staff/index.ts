// invite-staff: RETIRED. Kept only so the old address answers clearly instead of doing the old thing.
//
// The first version of this function invited a person by email and, if they already had an account, attached that account to
// the clinic without asking them. That is not allowed any more: an existing user must accept an invitation first. New staff
// accounts are made by the `staff-account` function, which checks the clinic owner itself and sends an email only when the
// provider really accepted it.
//
// This stub needs no secrets and touches no data. Deploy it with "Verify JWT" on, over the old function.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve((req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  return new Response(
    JSON.stringify({
      ok: false,
      code: 'function_retired',
      message: 'This way of adding staff has been replaced. Update the app and use Add staff on the Settings page.',
    }),
    { status: 410, headers: { ...CORS, 'Content-Type': 'application/json' } },
  );
});
