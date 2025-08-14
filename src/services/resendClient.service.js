import Resend from "resend"

const resend = new Resend(process.env.RESEND_API_KEY)

const sendEmail = async (emailData) => {
    const body = `Hi ${emailData.name},

Welcome to the International Journal for Social Work and Development Studies (IJSDS) — we’re glad you’re here. To kick off the review process, a *₦5,000 vetting fee* is required. This covers our initial checks (scope, formatting, and basic quality screening).

If your article is accepted after peer review, a *₦20,000 processing fee* will apply before publication.

Questions, refunds policy, or want us to check one last citation for you? Reply to this email or contact: *[editor@ijsds.org](mailto:editor@ijsds.org)*.

Welcome aboard — let’s get your research seen. ✨

Warmly,
*Editorial Team*
International Journal for Social Work and Development Studies`
    try {
        await resend.emails.send({
        from :"<noreply@ijsds.org>",
        to:emailData.to,
        subject:'Welcome to IJSDS — Submission & Fee Information',
        html:body
    })
    } catch (error) {
        if(error) throw error
    }
}

export default sendEmail