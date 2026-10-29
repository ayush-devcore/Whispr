const $ = (s) => document.querySelector(s);
let register = false;
function setMode() {
  $("#form-title").textContent = register
    ? "Create your account"
    : "Welcome back";
  $("#form-subtitle").textContent = register
    ? "Start a private conversation."
    : "Log in to continue your conversations.";
  $("#name").hidden = $("#name-label").hidden = !register;
  $("#admin-bootstrap-token").hidden = $("#bootstrap-label").hidden = $("#bootstrap-hint").hidden = !register;
  $("#auth-submit").textContent = register ? "Create account" : "Log in";
  $("#switch-copy").innerHTML = register
    ? 'Already have an account? <a href="#" id="switch-auth">Log in</a>'
    : 'New here? <a href="#" id="switch-auth">Create an account</a>';
  $("#switch-auth").onclick = (e) => {
    e.preventDefault();
    register = !register;
    setMode();
  };
}
$("#auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const error = $("#auth-error");
  error.textContent = "";
  const payload = { email: $("#email").value, password: $("#password").value };
  if (register) payload.name = $("#name").value;
  if (register && $("#admin-bootstrap-token").value) payload.adminBootstrapToken = $("#admin-bootstrap-token").value;
  try {
    const r = await fetch(`/api/auth/${register ? "register" : "login"}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (!r.ok) throw Error(data.error);
    localStorage.setItem("whispr_token", data.token);
    location.href = "interface.html";
  } catch (err) {
    error.textContent = err.message || "Unable to continue.";
  }
});
setMode();
