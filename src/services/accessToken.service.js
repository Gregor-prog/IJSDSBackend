const userProfile = async (orcidData) => {
    const getUser = await fetch(`https://pub.orcid.org/v3.0/${orcidData.orcid}/person`, {
        headers: {
            Authorization: `Bearer ${orcidData.access_token}`,
            "Accept": "application/json",
      "Content-Type": "application/x-www-form-urlencoded"
        }
    })
    const profile = await getUser.json()

    return profile
}

export default userProfile