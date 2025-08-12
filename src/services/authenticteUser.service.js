import { createClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ROLE_KEY // make sure it's the Service Role Key
);

const authUser = async (name, email, orcid) => {
    // Check if user exists in profiles
    const { data: existingProfiles, error: fetchError } = await supabase
        .from('profiles')
        .select("*")
        .eq('email', email);
    console.log(existingProfiles)
    if (fetchError) throw fetchError;

    let userId;

    if (existingProfiles.length > 0) {
        // Update existing profile
        userId = existingProfiles[0].id;
        const { error: updateError } = await supabase
            .from('profiles')
            .update({ orcid_id: orcid })
            .eq('id', userId);
        if (updateError) throw updateError;
        console.log("user exists")
    } else if(existingProfiles.length == 0) {
        // Create user in auth.users without sending confirmation email
        const { data: newUser, error } = await supabase.auth.admin.createUser({
            email:email,
            password: `${email}-temp`
        });
        if (error) throw error;

        console.log("user does not exist")


        userId = newUser.user.id;

        // Insert into profiles
        const { error: insertError } = await supabase
            .from('profiles')
            .insert([{ id: userId, full_name: name, email:email, orcid_id: orcid }]);
        if (insertError) throw insertError;
    }

    // Generate magic link
    const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
        type: "magiclink",
        email,
        options: {
            redirectTo: 'https://www.ijsds.org/'
        }
    });
    if (linkError) throw linkError;
    console.log(linkData)

    return linkData.properties.action_link;
};


export default authUser;
