const getAccessCode = async (code) => {
      const exchange = await fetch("https://sandbox.orcid.org/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json"
    },
    body: new URLSearchParams({
      client_id: process.env.CLIENT_ID,
      client_secret: process.env.CLIENT_SECRET,
      grant_type: "authorization_code",
      code: code,
      redirect_uri: "https://ijsdsbackend.onrender.com/auth/orcid"
    })
  });

  const res = await exchange.json()
  return res
}

export default getAccessCode